// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Energy Battery authors. See LICENSE.
// Rate limits and the auth limits built on them, against a real SQLite database
// built from schema.sql.
// Run: node --test --test-force-exit tests/ratelimit.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshEnv, pbkdf2 } from './helpers/d1.mjs';
import { overLimit, hitCount, ipKey } from '../src/lib/ratelimit.js';
import worker from '../src/worker.js';

const ORIGIN = 'https://copy.example.com';
const UID = '11111111-2222-4333-8444-555555555555';
const EMAIL = 'a@example.com';
const PW = 'correct-horse-1';
const send = (env, method, path, body, { ip = '203.0.113.7', cookie } = {}) => worker.fetch(new Request(ORIGIN + path, {
  method, headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(cookie ? { Cookie: cookie } : {}) },
  body: typeof body === 'string' ? body : JSON.stringify(body),
}), env, { waitUntil() {} });
const post = (env, path, body, ip) => send(env, 'POST', path, body, { ip });
async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Buffer.from(d).toString('hex');
}
async function addUser(db, { verified = 1 } = {}) {
  db.prepare('INSERT INTO users (id, email, password_hash, created_at, email_verified, token_version) VALUES (?, ?, ?, ?, ?, 0)')
    .run(UID, EMAIL, await pbkdf2(PW), new Date().toISOString(), verified);
}
async function addCode(db, code) {
  const now = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO email_verification_tokens (token, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)')
    .run(await sha256Hex(UID + ':' + code), UID, now + 1800, now);
}
const addHit = (db, key, ago = 60, n = 1) => { const now = Math.floor(Date.now() / 1000); for (let i = 0; i < n; i++) db.prepare('INSERT INTO rate_limits (key, created_at, expires_at) VALUES (?, ?, ?)').run(key, now - ago, now + 86400); };
const quiet = async (fn) => { const log = console.log, err = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = log; console.error = err; } };

test('allows up to max hits in the window, then blocks', async () => {
  const { env } = freshEnv();
  for (let i = 0; i < 3; i++) assert.equal(await overLimit(env, 'reset-email:a@example.com', 3, 900), false);
  assert.equal(await overLimit(env, 'reset-email:a@example.com', 3, 900), true);
  assert.equal(await overLimit(env, 'reset-email:a@example.com', 3, 900), true);
});

test('keys are independent', async () => {
  const { env } = freshEnv();
  assert.equal(await overLimit(env, 'vr:a@example.com', 1, 60), false);
  assert.equal(await overLimit(env, 'vr:a@example.com', 1, 60), true);
  assert.equal(await overLimit(env, 'vr:c@example.org', 1, 60), false);
});

test('hits older than the window fall off and get cleaned up', async () => {
  const { env, db } = freshEnv();
  addHit(db, 'k:u1', 1000, 5);
  assert.equal(await overLimit(env, 'k:u1', 3, 900), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?').get('k:u1').n, 1);
});

test('a refused hit is not kept, so hammering a capped key cannot keep it capped', async () => {
  const { env, db } = freshEnv();
  for (let i = 0; i < 3; i++) await overLimit(env, 'reset-email:a@example.com', 3, 900);
  for (let i = 0; i < 10; i++) assert.equal(await overLimit(env, 'reset-email:a@example.com', 3, 900), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?').get('reset-email:a@example.com').n, 3);
});

test('fails open when D1 throws', async () => {
  const env = { DB: { prepare() { throw new Error('D1 down'); } } };
  await quiet(async () => assert.equal(await overLimit(env, 'signup-ip:1.2.3.4', 1, 60), false));
});

test('a burst of parallel requests cannot slip past the cap', async () => {
  const { env } = freshEnv();
  const results = await Promise.all(Array.from({ length: 20 }, () => overLimit(env, 'vc:burst@example.com', 3, 60)));
  assert.equal(results.filter(over => !over).length, 3, 'exactly 3 of 20 parallel attempts should get through');
});

test('hitCount returns the count including this hit', async () => {
  const { env } = freshEnv();
  assert.equal(await hitCount(env, 'k', 60), 1);
  assert.equal(await hitCount(env, 'k', 60), 2);
});

test('ipKey: IPv4 as is, IPv6 cut to its /64', () => {
  const r = (ip) => new Request('https://x.example', { headers: { 'CF-Connecting-IP': ip } });
  assert.equal(ipKey(r('203.0.113.7')), '203.0.113.7');
  assert.equal(ipKey(r('2001:db8:1:2:aaaa:bbbb:cccc:dddd')), ipKey(r('2001:db8:1:2::1')));
  assert.notEqual(ipKey(r('2001:db8:1:2::1')), ipKey(r('2001:db8:1:3::1')));
});

test('login: 20 parallel wrong passwords, exactly 5 reach the password check', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  const codes = await quiet(() => Promise.all(Array.from({ length: 20 }, () => post(env, '/api/auth/login', { email: EMAIL, password: 'wrong-password-1' }).then(r => r.status))));
  // 10 per network per 5 minutes is the outer cap, 5 per account + network the inner one.
  assert.equal(codes.filter(c => c === 401).length, 5);
  assert.equal(codes.filter(c => c === 429).length, 15);
  assert.equal(codes.filter(c => c >= 500).length, 0);
});

test('login: the right password works over and over, and after 2 wrong ones', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  await quiet(async () => {
    for (let i = 0; i < 7; i++) assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: PW }, '198.51.100.' + i)).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: 'nope-nope-nope' }, '192.0.2.1')).status, 401);
    assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: PW }, '192.0.2.1')).status, 200);
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key = 'failed-login-all:a@example.com'").get().n, 2);
});

test('login: a stranger who burns 5 tries locks out their own network only', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  await quiet(async () => {
    for (let i = 0; i < 5; i++) assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: 'guess-guess-' + i }, '192.0.2.9')).status, 401);
    assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: PW }, '192.0.2.9')).status, 429);
    assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: PW }, '203.0.113.50')).status, 200);
  });
});

test('verify-code: 5 wrong codes burn the code, so the right one no longer works', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 }); await addCode(db, '123456');
  await quiet(async () => {
    for (let i = 0; i < 5; i++) assert.equal((await post(env, '/api/auth/verify-code', { email: EMAIL, code: '00000' + i, password: PW })).status, 400);
    assert.equal((await post(env, '/api/auth/verify-code', { email: EMAIL, code: '123456', password: PW })).status, 400);
  });
  assert.equal(db.prepare('SELECT email_verified AS v FROM users WHERE id = ?').get(UID).v, 0);
});

test('verify-code: the right code still works after a few misses', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 }); await addCode(db, '123456');
  await quiet(async () => {
    for (let i = 0; i < 3; i++) assert.equal((await post(env, '/api/auth/verify-code', { email: EMAIL, code: '00000' + i, password: PW })).status, 400);
    assert.equal((await post(env, '/api/auth/verify-code', { email: EMAIL, code: '123456', password: PW })).status, 200);
  });
});

test('verify-code: 20 misses in a day close the account to guessing, even with a fresh code', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 });
  addHit(db, 'verify-miss-day:' + UID, 7200, 20);
  await addCode(db, '654321');
  await quiet(async () => assert.equal((await post(env, '/api/auth/verify-code', { email: EMAIL, code: '654321', password: PW })).status, 400));
});

test('verify-code: 30 parallel wrong codes, the caps hold and none is a 500', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 }); await addCode(db, '123456');
  const codes = await quiet(() => Promise.all(Array.from({ length: 30 }, (_, i) => post(env, '/api/auth/verify-code', { email: EMAIL, code: String(100000 + i), password: PW }, '198.51.100.' + i).then(r => r.status))));
  assert.equal(codes.filter(c => c === 400).length, 8);
  assert.equal(codes.filter(c => c === 429).length, 22);
});

test('verify-code: a right code hands its daily try back', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 }); await addCode(db, '123456');
  await quiet(async () => assert.equal((await post(env, '/api/auth/verify-code', { email: EMAIL, code: '123456', password: PW })).status, 200));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'verify-miss-day:%'").get().n, 0);
});

test('password reset: using one link kills every other link, and a link works once', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  const later = new Date(Date.now() + 3600000).toISOString();
  for (const raw of ['a'.repeat(64), 'b'.repeat(64)]) db.prepare('INSERT INTO reset_tokens (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)').run(await sha256Hex(raw), UID, later);
  await quiet(async () => {
    assert.equal((await post(env, '/api/auth/reset-confirm', { token: 'a'.repeat(64), password: 'brand-new-pass-1' })).status, 200);
    assert.equal((await post(env, '/api/auth/reset-confirm', { token: 'a'.repeat(64), password: 'brand-new-pass-2' })).status, 400);
    assert.equal((await post(env, '/api/auth/reset-confirm', { token: 'b'.repeat(64), password: 'brand-new-pass-3' })).status, 400);
  });
});

test('password reset clears the wrong-password counters', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  db.prepare('INSERT INTO reset_tokens (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)').run(await sha256Hex('c'.repeat(64)), UID, new Date(Date.now() + 3600000).toISOString());
  await quiet(async () => {
    for (let i = 0; i < 5; i++) await post(env, '/api/auth/login', { email: EMAIL, password: 'guess-guess-' + i }, '192.0.2.9');
    assert.equal((await post(env, '/api/auth/reset-confirm', { token: 'c'.repeat(64), password: 'brand-new-pass-1' }, '192.0.2.9')).status, 200);
    assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: 'brand-new-pass-1' }, '192.0.2.9')).status, 200);
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'failed-login%'").get().n, 0);
});

test('password reset on an unverified account verifies it, so the next login works', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 });
  db.prepare('INSERT INTO reset_tokens (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)').run(await sha256Hex('d'.repeat(64)), UID, new Date(Date.now() + 3600000).toISOString());
  await quiet(async () => {
    assert.equal((await post(env, '/api/auth/reset-confirm', { token: 'd'.repeat(64), password: 'brand-new-pass-1' })).status, 200);
    assert.equal((await post(env, '/api/auth/login', { email: EMAIL, password: 'brand-new-pass-1' })).status, 200);
  });
});

test('change password and delete account share the login lockout', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  await quiet(async () => {
    const login = await post(env, '/api/auth/login', { email: EMAIL, password: PW });
    const cookie = login.headers.get('Set-Cookie').split(';')[0];
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await send(env, 'PUT', '/api/auth/password', { current_password: 'guess-guess-' + i, password: 'brand-new-pass-1' }, { cookie })).status);
    for (let i = 0; i < 3; i++) codes.push((await send(env, 'DELETE', '/api/auth/account', { current_password: 'guess-guess-' + i }, { cookie })).status);
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429, 429]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
    // The owner on another network still gets through with the right password.
    assert.equal((await send(env, 'DELETE', '/api/auth/account', { current_password: PW }, { cookie, ip: '198.51.100.20' })).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  });
});

test('a body that is not a JSON object is a 400 or a plain 200, never a 500', async () => {
  const { env, db } = freshEnv(); await addUser(db);
  await quiet(async () => {
    let n = 0;
    for (const path of ['signup', 'login', 'verify-code', 'resend-code', 'reset-request', 'reset-confirm', 'hub-sso']) {
      for (const raw of ['5', 'null', '"s"', '[1]', '{bad']) {
        const r = await send(env, 'POST', '/api/auth/' + path, raw, { ip: '198.51.100.' + (n++) });
        assert.ok(r.status < 500, `${path} ${raw} gave ${r.status}`);
      }
    }
  });
});

test('a junk session cookie is a 401, never a 500', async () => {
  const { env } = freshEnv();
  for (const payload of ['bnVsbA', 'NQ', 'InMi', 'W10']) { // null, 5, "s", []
    for (const [method, path] of [['GET', '/api/me'], ['POST', '/api/auth/logout'], ['GET', '/api/checkins']]) {
      const r = await worker.fetch(new Request(ORIGIN + path, { method, headers: { Origin: ORIGIN, Cookie: `eb_session=x.${payload}.x` } }), env, { waitUntil() {} });
      assert.ok(r.status < 500, `${method} ${path} with payload ${payload} gave ${r.status}`);
    }
  }
});

test('new accounts: 20 a day per network, and a whole IPv6 /64 is one network', async () => {
  const { env, db } = freshEnv();
  addHit(db, 'signup-day:2001:db8:1:2::/64', 7200, 20);
  await quiet(async () => {
    assert.equal((await post(env, '/api/auth/signup', { email: 'n1@example.com', password: 'long-enough-pass-1' }, '2001:db8:1:2::99')).status, 429);
    assert.equal((await post(env, '/api/auth/signup', { email: 'n2@example.com', password: 'long-enough-pass-1' }, '2001:db8:1:3::99')).status, 200);
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
});

test('the old emailed verify link no longer verifies anything', async () => {
  const { env, db } = freshEnv(); await addUser(db, { verified: 0 }); await addCode(db, '123456');
  const r = await worker.fetch(new Request(ORIGIN + '/api/auth/verify-email?token=' + UID + ':123456'), env, { waitUntil() {} });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /expired/);
  assert.equal(db.prepare('SELECT email_verified AS v FROM users WHERE id = ?').get(UID).v, 0);
});
