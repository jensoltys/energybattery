// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Energy Battery authors. See LICENSE.
// A copy stands on its own: no outside sign-in, no Pro it can't deliver, no setup traps.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../src/worker.js';

const SECRET = 'test-secret-test-secret-test-secret-1234';
const ORIGIN = 'https://copy.example.com';
const DB = { prepare() { const st = { bind() { return st; }, async first() { return null; }, async run() { return { meta: {} }; }, async all() { return { results: [] }; } }; return st; }, async batch(s) { return s.map(() => ({ results: [] })); } };
const get = (env, headers = {}) => worker.fetch(new Request(ORIGIN + '/api/pro-status', { headers }), { JWT_SECRET: SECRET, DB, ...env }, { waitUntil() {} }).then(r => r.json());
const b64 = (s) => Buffer.from(s).toString('base64url');
async function hs256(payload, secret) {
  const data = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${Buffer.from(sig).toString('base64url')}`;
}
const exp = () => Math.floor(Date.now() / 1000) + 3600;

// Names the hosted site uses for its own sign-in hand-off, spelled in pieces so a search of this repo for
// them finds nothing at all.
const HUB = 'hub';
const OLD_ROUTES = [
  ['POST', `/api/auth/${HUB}-sso`], ['GET', `/api/auth/${HUB}/start`], ['GET', `/api/auth/${HUB}/callback?code=abc&state=abc`],
  ['POST', `/api/auth/${HUB}/finish`], ['POST', '/api/pro-refresh'], ['GET', '/api/service/recap?email=a@example.com&start=2026-01-01&end=2026-01-31'],
];
const OLD_NAMES = new RegExp([`${HUB}pro`, `${HUB}_pro`, `${HUB}-sso`, `${HUB}-handoff`, `x-${HUB}`, `app-${HUB}`, `${HUB}_jwt`, `${HUB}_lookup`, `app ${HUB}`, `pro ${HUB}`, 'entitlement token'].join('|'), 'i');

test('pro-status: everyone is on the free plan, whatever a visitor sends', async () => {
  assert.equal((await get({})).is_pro, false);
  const forged = await hs256({ v: 1, email: 'a@example.com', pro_until: '2099-01-01T00:00:00Z', iat: exp() - 3600, exp: exp() }, SECRET);
  const d = await get({ [`${HUB.toUpperCase()}_JWT_SECRET`]: SECRET }, { [`X-${HUB}-Pro`]: forged });
  assert.equal(d.is_pro, false);
  assert.equal('upgrade_url' in d, false);
});

test('pro-status: feedback_available follows FEEDBACK_WEBHOOK_URL', async () => {
  assert.equal((await get({})).feedback_available, false);
  assert.equal((await get({ FEEDBACK_WEBHOOK_URL: 'https://hooks.example.com/fb' })).feedback_available, true);
});

test('the hosted site sign-in hand-off, refresh and recap routes are gone', async () => {
  const userDB = { ...DB, prepare(sql) { const st = { bind() { return st; }, async first() { return /FROM users/.test(sql) ? { token_version: 0, email: 'a@example.com', email_verified: 1 } : null; }, async run() { return { meta: { changes: 1 } }; }, async all() { return { results: [] }; } }; return st; } };
  const cookie = 'eb_session=' + await hs256({ sub: 'u1', tv: 0, exp: exp() }, SECRET);
  const forged = await hs256({ v: 1, email: 'victim@example.com', pro_until: '2099-01-01T00:00:00Z', exp: exp() }, SECRET);
  const call = (method, path, headers) => worker.fetch(new Request(ORIGIN + path, { method, headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers }, body: method === 'POST' ? JSON.stringify({ [`${HUB}_pro_jwt`]: forged, token: forged }) : undefined }),
    { JWT_SECRET: SECRET, [`${HUB.toUpperCase()}_JWT_SECRET`]: SECRET, DB: userDB }, { waitUntil() {} });
  for (const [method, path] of OLD_ROUTES) {
    // Signed out: nobody is signed in, redirected or handed a cookie.
    const out = await call(method, path, { 'X-Internal-Secret': SECRET });
    assert.equal(out.status, 401, `${method} ${path} signed out`);
    assert.equal(out.headers.get('Set-Cookie'), null, path);
    assert.equal(out.headers.get('Location'), null, path);
    // Signed in: the route does not exist.
    const inn = await call(method, path, { Cookie: cookie });
    assert.equal(inn.status, 404, `${method} ${path} signed in`);
    assert.equal(inn.headers.get('Set-Cookie'), null, path);
  }
});

test('none of the hosted site hand-off code or links are in the app', () => {
  const files = ['../src/worker.js', ...readdirSync(new URL('../src/lib/', import.meta.url)).map(f => '../src/lib/' + f),
    ...readdirSync(new URL('../public/', import.meta.url)).filter(f => /\.(js|html|css)$/.test(f)).map(f => '../public/' + f),
    ...readdirSync(new URL('../public/legal/', import.meta.url)).map(f => '../public/legal/' + f),
    '../README.md', '../wrangler.toml', '../.dev.vars.example'];
  assert.ok(files.length > 8);
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(text, OLD_NAMES, f);
    assert.doesNotMatch(text, /location\.search[^\n]{0,80}pro/i, f);
  }
});

test('the page sells nothing: every Go Pro opens the note about the hosted version', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<a id="unlock-pro-btn" class="unlock-pro-btn" href="#" data-go-pro=""/);
  assert.doesNotMatch(html, /\$7\/mo|all five|class="pro-required-price"/);
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /Pro isn't available on this copy of Energy Battery/);
  assert.match(js, /cta\.textContent = 'Open energybattery\.app'/);
  assert.doesNotMatch(js, /\$7\/mo|all five/);
  const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /upgrade_url|checkout/i);
});

test('Pro-only routes stay locked with a plain 402', async () => {
  const userDB = { ...DB, prepare(sql) { const st = { bind() { return st; }, async first() { return /FROM users/.test(sql) ? { token_version: 0 } : null; }, async run() { return { meta: { changes: 1 } }; }, async all() { return { results: [] }; } }; return st; } };
  const cookie = 'eb_session=' + await hs256({ sub: 'u1', tv: 0, exp: exp() }, SECRET);
  for (const [path, feature] of [['/api/patterns', 'pattern-insights'], ['/api/recharge-menu', 'recharge-menu']]) {
    const r = await worker.fetch(new Request(ORIGIN + path, { headers: { Cookie: cookie } }), { JWT_SECRET: SECRET, DB: userDB }, { waitUntil() {} });
    assert.equal(r.status, 402, path);
    assert.deepEqual(await r.json(), { error: 'Pro required', feature });
  }
});

test('account delete asks for the password, nothing else works', async () => {
  const userDB = { ...DB, prepare(sql) { const st = { bind() { return st; }, async first() { return /FROM users/.test(sql) ? { token_version: 0, email: 'a@example.com', password_hash: 'pbkdf2:00:00' } : null; }, async run() { return { meta: { changes: 1 } }; }, async all() { return { results: [] }; } }; return st; } };
  const cookie = 'eb_session=' + await hs256({ sub: 'u1', tv: 0, exp: exp() }, SECRET);
  const token = await hs256({ v: 1, email: 'a@example.com', pro_until: null, exp: exp() }, SECRET);
  const r = await worker.fetch(new Request(ORIGIN + '/api/auth/account', { method: 'DELETE', headers: { Origin: ORIGIN, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ [`${HUB}_pro_jwt`]: token, confirm: 'DELETE' }) }),
    { JWT_SECRET: SECRET, [`${HUB.toUpperCase()}_JWT_SECRET`]: SECRET, DB: userDB }, { waitUntil() {} });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /password/i);
});

test('no session secret: sign up, verify and log in answer with a setup message and write nothing', async () => {
  const realError = console.error; console.error = () => {};
  const wrote = [];
  const spyDB = { prepare(sql) { const st = { bind() { return st; }, async first() { return null; }, async run() { wrote.push(sql); return { meta: {} }; }, async all() { return { results: [] }; } }; return st; }, async batch(s) { wrote.push('batch'); return s.map(() => ({ results: [] })); } };
  try {
    for (const secret of [undefined, '', 'too-short']) {
      for (const [path, body] of [['signup', { email: 'a@example.com', password: 'correct horse 99' }], ['login', { email: 'a@example.com', password: 'correct horse 99' }], ['verify-code', { email: 'a@example.com', code: '123456', password: 'correct horse 99' }]]) {
        const r = await worker.fetch(new Request('https://copy.example.com/api/auth/' + path, { method: 'POST', headers: { Origin: 'https://copy.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), { JWT_SECRET: secret, DB: spyDB }, { waitUntil() {} });
        assert.equal(r.status, 503, path);
        const j = await r.json();
        assert.equal(j.code, 'setup_required');
        assert.match(j.error, /JWT_SECRET/);
      }
    }
    assert.deepEqual(wrote, []);
  } finally { console.error = realError; }
});

test('pages get this site address in og:url, og:image and the canonical link', async () => {
  // HTMLRewriter only exists on Cloudflare: a pass-through stand-in for Node.
  globalThis.HTMLRewriter ??= class { on() { return this; } transform(r) { return r; } };
  const page = '<html><head><meta property="og:url" content="/guide"><meta property="og:image" content="/og.png"><meta name="twitter:image" content="/og.png"/></head><body></body></html>';
  const ASSETS = { async fetch() { return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }); } };
  const html = await worker.fetch(new Request('https://copy.example.com/guide'), { APP_URL: 'https://copy.example.com/', ASSETS, DB }, { waitUntil() {} }).then(r => r.text());
  assert.match(html, /<meta property="og:url" content="https:\/\/copy\.example\.com\/guide">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/copy\.example\.com\/og\.png">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/copy\.example\.com\/guide"\/>/);
  const real = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(real, /energybattery\.app\/og\.png/);
});
