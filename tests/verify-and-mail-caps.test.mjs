// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Energy Battery authors. See LICENSE.
// Verification and mail-cap rules:
//  verify-code needs the account password as well as the code.
//  an already-verified email gets the same 400 as an unknown one (no 409).
//  per-address mail cap + global daily mail ceiling on signup, resend, reset,
//     charged only for real sends, and invisible in the response.
//  Review follow-up: verify-code's final UPDATE is conditional + atomic.
// Runs against a real SQLite database built from schema.sql.
// Run: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshEnv, pbkdf2 } from './helpers/d1.mjs';
import worker from '../src/worker.js';

const ORIGIN = 'https://copy.example.com';
const PW = 'correct-horse-1';
const sha = s => createHash('sha256').update(s).digest('hex');

// Resend is stubbed so a real send reports email_sent:true; we count calls.
let mailsSent = 0;
globalThis.fetch = async (url) => {
  if (String(url).startsWith('https://api.resend.com/')) { mailsSent++; return new Response('{}', { status: 200 }); }
  return new Response('{}', { status: 404 });
};
const quiet = async (fn) => { const log = console.log, err = console.error; console.log = () => {}; console.error = () => {}; try { return await fn(); } finally { console.log = log; console.error = err; } };

async function makeEnv() {
  const { env, db } = freshEnv({ JWT_SECRET: 'test-secret-test-secret-test-secret-1234', RESEND_API_KEY: 'test', APP_URL: ORIGIN });
  const now = new Date().toISOString();
  const add = db.prepare('INSERT INTO users (id, email, password_hash, email_verified, token_version, created_at) VALUES (?, ?, ?, ?, 0, ?)');
  add.run('u-new', 'new@example.com', await pbkdf2(PW), 0, now);
  add.run('u-old', 'old@example.com', await pbkdf2(PW), 1, now);
  const t = Math.floor(Date.now() / 1000);
  db.prepare('INSERT INTO email_verification_tokens (token, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)').run(sha('u-new:123456'), 'u-new', t + 600, t);
  env.db = db;
  env.user = (email) => db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  env.daily = (k) => db.prepare('SELECT n FROM email_daily WHERE k = ? AND day = ?').get(k, today())?.n;
  return env;
}
const today = () => new Date().toISOString().slice(0, 10);
function post(path, body, ip = '1.1.1.1') {
  return new Request(ORIGIN + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': ip }, body: JSON.stringify(body) });
}
const call = (env, path, body, ip) => quiet(() => worker.fetch(post(path, body, ip), env, { waitUntil() {} }));

test('verify-code without a password is a 400 and verifies nothing', async () => {
  const env = await makeEnv();
  const r = await call(env, '/api/auth/verify-code', { email: 'new@example.com', code: '123456' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /password/);
  assert.equal(env.user('new@example.com').email_verified, 0);
});

test('verify-code with the right code but wrong password is a 400, no session, not verified', async () => {
  const env = await makeEnv();
  const r = await call(env, '/api/auth/verify-code', { email: 'new@example.com', code: '123456', password: 'wrong-password-1' });
  assert.equal(r.status, 400);
  assert.equal(r.headers.get('Set-Cookie'), null);
  assert.equal(env.user('new@example.com').email_verified, 0);
});

test('verify-code with the right code and password verifies and sets the session', async () => {
  const env = await makeEnv();
  const r = await call(env, '/api/auth/verify-code', { email: 'new@example.com', code: '123456', password: PW });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('Set-Cookie') || '', /eb_session=/);
  assert.equal(env.user('new@example.com').email_verified, 1);
});

test('already-verified email gets the same 400 as an unknown email', async () => {
  const env = await makeEnv();
  const a = await call(env, '/api/auth/verify-code', { email: 'old@example.com', code: '123456', password: PW });
  const b = await call(env, '/api/auth/verify-code', { email: 'nobody@example.com', code: '123456', password: PW });
  assert.equal(a.status, 400);
  assert.equal(b.status, 400);
  assert.deepEqual(await a.json(), await b.json());
});

test('verify-code: a password swapped in after the check gets the invalid-code 400, no session', async () => {
  const env = await makeEnv();
  // Simulate a parallel signup landing right after verify-code read the row.
  const real = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const stmt = real(sql);
    if (!/FROM users WHERE email/.test(sql)) return stmt;
    const first = stmt.first.bind(stmt);
    stmt.first = async () => { const row = await first(); env.db.prepare("UPDATE users SET password_hash='pbkdf2:00:attacker', token_version=1 WHERE email='new@example.com'").run(); return row; };
    return stmt;
  };
  const r = await call(env, '/api/auth/verify-code', { email: 'new@example.com', code: '123456', password: PW });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, 'That code is invalid or expired.');
  assert.equal(r.headers.get('Set-Cookie'), null);
  assert.equal(env.user('new@example.com').email_verified, 0);
});

test('reset-request: per-address cap counts real sends only, same 200 every time', async () => {
  const env = await makeEnv();
  mailsSent = 0;
  for (let i = 0; i < 5; i++) {
    const r = await call(env, '/api/auth/reset-request', { email: 'nobody@example.com' }, `9.9.8.${i}`);
    assert.deepEqual([r.status, await r.json()], [200, { success: true }]);
  }
  assert.equal(env.daily('reset-mail'), undefined, 'unknown address charges nothing');
  for (let i = 0; i < 5; i++) {
    const r = await call(env, '/api/auth/reset-request', { email: 'old@example.com' }, `9.9.9.${i}`);
    assert.deepEqual([r.status, await r.json()], [200, { success: true }]);
  }
  assert.equal(mailsSent, 3);
  assert.equal(env.daily('reset-mail'), 3);
});

test('reset-request: at the daily ceiling nothing is sent, same 200 for known and unknown', async () => {
  const env = await makeEnv();
  mailsSent = 0;
  env.db.prepare('INSERT INTO email_daily (k, day, n) VALUES (?, ?, 150)').run('reset-mail', today());
  const a = await call(env, '/api/auth/reset-request', { email: 'old@example.com' });
  const b = await call(env, '/api/auth/reset-request', { email: 'nobody@example.com' }, '2.2.2.2');
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual(await a.json(), await b.json());
  assert.equal(mailsSent, 0);
});

test('signup: per-address cap skips the 4th mail but the answer is unchanged', async () => {
  const env = await makeEnv();
  mailsSent = 0;
  const bodies = [];
  for (let i = 0; i < 4; i++) {
    const r = await call(env, '/api/auth/signup', { email: 'fresh@example.com', password: PW }, `8.8.8.${i}`);
    assert.equal(r.status, 200);
    bodies.push(await r.json());
  }
  for (const b of bodies) assert.deepEqual(b, bodies[0]);
  assert.equal(bodies[0].email_sent, true);
  assert.equal(mailsSent, 3);
});

test('signup on a verified address and resend for unknown/verified ones charge nothing', async () => {
  const env = await makeEnv();
  mailsSent = 0;
  await call(env, '/api/auth/signup', { email: 'old@example.com', password: PW }, '7.7.7.1');
  await call(env, '/api/auth/resend-code', { email: 'nobody@example.com' }, '7.7.7.2');
  await call(env, '/api/auth/resend-code', { email: 'old@example.com' }, '7.7.7.3');
  assert.equal(env.daily('verify-mail'), undefined);
  assert.equal(mailsSent, 0);
});

test('at the daily verification ceiling signup + resend still answer as normal, no mail', async () => {
  const env = await makeEnv();
  mailsSent = 0;
  env.db.prepare('INSERT INTO email_daily (k, day, n) VALUES (?, ?, 150)').run('verify-mail', today());
  const s = await call(env, '/api/auth/signup', { email: 'fresh@example.com', password: PW });
  const r = await call(env, '/api/auth/resend-code', { email: 'new@example.com' }, '3.3.3.3');
  assert.equal(s.status, 200);
  assert.equal((await s.json()).email_sent, true);
  assert.ok(env.user('fresh@example.com'), 'account still created');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).email_sent, true);
  assert.equal(mailsSent, 0);
});

test('one address gets at most 10 emails a day', async () => {
  const env = await makeEnv();
  mailsSent = 0;
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 10; i++) env.db.prepare('INSERT INTO rate_limits (key, created_at, expires_at) VALUES (?, ?, ?)').run('reset-email:old@example.com|day', now - 7200, now + 80000);
  const r = await call(env, '/api/auth/reset-request', { email: 'old@example.com' });
  assert.deepEqual([r.status, await r.json()], [200, { success: true }]);
  assert.equal(mailsSent, 0);
});
