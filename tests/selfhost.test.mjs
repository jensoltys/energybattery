// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Energy Battery authors. See LICENSE.
// A copy with no Pro hub must say so, so the page never sells Pro that can't unlock here.
// Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';

const DB = { prepare() { const st = { bind() { return st; }, async first() { return null; }, async run() { return { meta: {} }; }, async all() { return { results: [] }; } }; return st; }, async batch(s) { return s.map(() => ({ results: [] })); } };
const get = (env) => worker.fetch(new Request('https://copy.example.com/api/pro-status'), { JWT_SECRET: 'test-secret-test-secret-test-secret-1234', DB, ...env }, { waitUntil() {} }).then(r => r.json());
const HUB = 'hub-secret-hub-secret-hub-secret-12';

test('pro-status: no hub connected = pro_available false, everyone on the free plan', async () => {
  const d = await get({});
  assert.equal(d.pro_available, false);
  assert.equal(d.is_pro, false);
});

test('pro-status: hub connected = pro_available true', async () => {
  assert.equal((await get({ HUB_JWT_SECRET: HUB })).pro_available, true);
});

test('pro-status: no hub = no upgrade link or price, even if UPGRADE_URL is set', async () => {
  const d = await get({ UPGRADE_URL: 'https://pay.example.com/pro', PRO_PRICE_TEXT: '$5/mo' });
  assert.equal(d.upgrade_url, null);
  assert.equal(d.pro_price_text, null);
});

test('pro-status: hub + UPGRADE_URL + PRO_PRICE_TEXT come back as set', async () => {
  const d = await get({ HUB_JWT_SECRET: HUB, UPGRADE_URL: 'https://pay.example.com/pro', PRO_PRICE_TEXT: '$5 a month' });
  assert.equal(d.upgrade_url, 'https://pay.example.com/pro');
  assert.equal(d.pro_price_text, '$5 a month');
});

test('pro-status: a non-http UPGRADE_URL is ignored', async () => {
  assert.equal((await get({ HUB_JWT_SECRET: HUB, UPGRADE_URL: 'javascript:alert(1)' })).upgrade_url, null);
});

test('pro-status: feedback_available follows FEEDBACK_WEBHOOK_URL', async () => {
  assert.equal((await get({})).feedback_available, false);
  assert.equal((await get({ FEEDBACK_WEBHOOK_URL: 'https://hooks.example.com/fb' })).feedback_available, true);
});

test('static page fails closed: no paid upgrade link or price until the server says Pro is available', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /jenbuiltit\.com\/app-hub\/upgrade/);
  assert.match(html, /class="pro-required-price" id="pro-required-price" hidden><\/p>/);
  assert.doesNotMatch(html, /\$7\/mo|all five/);
  const js = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(js, /let proAvailable=false;/);
  assert.doesNotMatch(js, /jenbuiltit\.com\/app-hub\/upgrade|\$7\/mo|all five/);
});

test('402 upgrade_url follows UPGRADE_URL, and is left out when blank', () => {
  const src = readFileSync(new URL('../src/worker.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /jenbuiltit\.com/);
  assert.equal((src.match(/upgrade_url: upgradeUrl\(/g) || []).length, 2);
});

test('hub secrets shorter than 32 characters count as not set', async () => {
  const realError = console.error; console.error = () => {};
  try {
    const d = await get({ HUB_JWT_SECRET: 'abc', UPGRADE_URL: 'https://pay.example.com/pro' });
    assert.equal(d.pro_available, false);
    assert.equal(d.upgrade_url, null);
    const sso = await worker.fetch(new Request('https://copy.example.com/api/auth/hub-sso', { method: 'POST', headers: { Origin: 'https://copy.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ hub_pro_jwt: 'a.b.c' }) }),
      { JWT_SECRET: 'test-secret-test-secret-test-secret-1234', HUB_JWT_SECRET: 'abc', DB }, { waitUntil() {} });
    assert.equal(sso.status, 404);
  } finally { console.error = realError; }
});

test('pro-refresh is off without PRO_REFRESH_URL', async () => {
  const r = await worker.fetch(new Request('https://copy.example.com/api/pro-refresh', { method: 'POST', headers: { Origin: 'https://copy.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'x' }) }),
    { JWT_SECRET: 'test-secret-test-secret-test-secret-1234', DB }, { waitUntil() {} });
  assert.equal(r.status, 404);
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
