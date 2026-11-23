// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Energy Battery authors. See LICENSE.
// worker.js — Energy Battery API
// Cloudflare Worker + D1 database
// Auth: PBKDF2 password hashing + HS256 JWT (30-day sessions)

import { verifyHubPro } from './lib/verify-hub-pro.js';
import { reportServerError, alertPayloadFor, stripAlertHeader, markNoAlert } from './lib/alert.js';
import { emailLayout, emailPara, emailSmall, emailCode, emailButton } from './lib/email-look.js';
import { overLimit, hitCount, dropNewest, ipKey } from './lib/ratelimit.js';

// Email theme ("Ember Dusk" + Glow). Layout: lib/email-look.js.
const EMAIL_THEME = {
  name: 'Energy Battery', get mascotUrl() { return APP_BASE + '/email-mascot.png'; }, mascotAlt: 'Glow the firefly', mascotW: 67,
  bg: '#0F1A1C', card: '#16262A', line: '#24393E', pri: '#FF7F66', pri2: '#E85F45', on: '#2B0C05', a2: '#FFC247', text: '#EEF5F3', muted: '#9BB3AE',
};

// Pro entitlement check: free-user SSO tokens carry pro_until=null. A verified
// hubPro payload alone is NOT proof of Pro — must also have a future pro_until.
function hasProAccess(hubPro) {
  return !!(hubPro?.email && hubPro?.pro_until && new Date(hubPro.pro_until) > new Date());
}
// A hub Pro token names its buyer. It counts only for the account it was bought
// for; presented by any other account it is treated as absent.
async function bindHubPro(hubPro, uid, env) {
  if (!hubPro?.email) return hubPro;
  const me = await env.DB.prepare('SELECT email FROM users WHERE id=?').bind(uid).first();
  return me && String(me.email).toLowerCase() === String(hubPro.email).toLowerCase() ? hubPro : null;
}

// Where Go Pro sends people when this copy has its own Pro hub (HUB_JWT_SECRET set):
// UPGRADE_URL in wrangler.toml. Blank, or no hub, = no upgrade link anywhere.
let UPGRADE_BASE = '';
function upgradeUrl(feature) {
  if (!UPGRADE_BASE) return undefined;
  return UPGRADE_BASE + (UPGRADE_BASE.includes('?') ? '&' : '?') + 'feature=' + encodeURIComponent(feature);
}

// The hub secrets sign logins and Pro, so a short one is as bad as none. Any of
// these set to fewer than 32 characters is treated as not set, and logged once.
const HUB_SECRET_NAMES = ['HUB_JWT_SECRET', 'HUB_LOOKUP_SECRET', 'RECAP_SERVICE_SECRET'];
const MIN_SECRET_LENGTH = 32;
let warnedShortSecret = false;
function usableEnv(env) {
  const short = HUB_SECRET_NAMES.filter(n => env[n] && String(env[n]).length < MIN_SECRET_LENGTH);
  if (!short.length) return env;
  if (!warnedShortSecret) {
    warnedShortSecret = true;
    console.error(`Ignoring ${short.join(', ')}: set to fewer than ${MIN_SECRET_LENGTH} characters, so treated as not set. Make one with: openssl rand -hex 32`);
  }
  const out = Object.create(env);
  for (const n of short) Object.defineProperty(out, n, { value: '', enumerable: true });
  return out;
}

// Link previews and search engines need full addresses. The pages ship with
// site-relative ones, so this fills in the site's own address (APP_URL) and adds
// the canonical link on the way out.
function absoluteMeta(html, base) {
  const b = escapeAttr(base);
  let canonical = '';
  html = html.replace(/(<meta (?:property|name)="(og:url|og:image|twitter:image)" content=")(\/[^"]*)"/g, (m, head, name, path) => {
    if (name === 'og:url') canonical = b + path;
    return head + b + path + '"';
  });
  if (canonical && !html.includes('<link rel="canonical"')) {
    html = html.replace('</head>', () => `<link rel="canonical" href="${canonical}"/>\n</head>`);
  }
  return html;
}
function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// This site's own address, from APP_URL in wrangler.toml. Set on every request.
let APP_BASE = '';
function setAppBase(env) {
  APP_BASE = String(env.APP_URL || '').replace(/\/+$/, '');
  const up = String(env.UPGRADE_URL || '').trim();
  UPGRADE_BASE = env.HUB_JWT_SECRET && /^https?:\/\//i.test(up) ? up : '';
}

// Per-request CORS headers — never module-scope mutable state.
// Module-scope `let _cors = {}` would race across in-flight requests in the
// same isolate (origin A's allow-origin leaking into origin B's response).
// A request is trusted only when its Origin is this site's own address, so a
// self-hosted copy works on any domain with nothing to configure.
function getCorsHeaders(request) {
  const allowOrigin = new URL(request.url).origin;
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Hub-Pro',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };
}

// CSRF Origin/Referer check. The session is an HttpOnly cookie, which the
// browser attaches to every request to this host no matter which site started
// it, so every state-changing request has to prove it came from one of our own
// pages: the origin the request was sent to.
// Returns null if OK, or a 403 Response.
function checkOrigin(request, cors) {
  const own = [new URL(request.url).origin];
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  if (origin) return own.includes(origin) ? null : res({ error: 'Forbidden' }, 403, cors);
  if (referer && own.some(o => referer.startsWith(o + '/'))) return null;
  return res({ error: 'Forbidden' }, 403, cors);
}

// State-changing routes that skip the Origin check, each with its reason.
// A route belongs here only if no browser ever calls it with our cookie.
// Energy Battery has none: its only secret-header route (/api/service/recap)
// is a GET, the cron runs as scheduled() not fetch(), and there is no Stripe
// webhook in this app. /api/feedback and /api/pro-refresh are called by our
// own pages, so they get the check like everything else.
const CSRF_EXEMPT = new Set([]);

// ── Session cookie ──────────────────────────────────────────────────────────
// The login session is an HS256 JWT held in an HttpOnly cookie, so page
// scripts can never read it. Same 30-day life as the JWT inside it.
const SESSION_COOKIE = 'eb_session';
const SESSION_TTL = 30 * 86400;
const COOKIE_ATTRS = 'Path=/; HttpOnly; Secure; SameSite=Lax';

function sessionCookie(jwt, maxAge = SESSION_TTL) {
  return `${SESSION_COOKIE}=${jwt}; ${COOKIE_ATTRS}; Max-Age=${Math.max(0, Math.floor(maxAge))}`;
}
function clearSessionCookie() {
  return `${SESSION_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`;
}
function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
async function mintSession(uid, tokenVersion, env) {
  return makeJWT({ sub: uid, tv: tokenVersion ?? 0, exp: Math.floor(Date.now() / 1000) + SESSION_TTL }, env.JWT_SECRET);
}
// A JSON response that also starts (or replaces) the session cookie.
function resWithSession(data, jwt, cors) {
  const r = res(data, 200, cors);
  r.headers.append('Set-Cookie', sessionCookie(jwt));
  return r;
}
function hasSession(request) {
  return !!readCookie(request, SESSION_COOKIE);
}

// SHA-256 hex helper — store opaque tokens (reset, email-verify) hashed-at-rest
// so a DB read can't replay them.
async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// One structured log line per auth event, kept by Workers Logs ([observability]
// in wrangler.toml). Never a raw email, password, token or IP: hashes only.
async function logAuth(type, request, { uid, email } = {}) {
  try {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const evt = { evt: 'auth', type };
    if (uid) evt.uid = uid;
    else if (email) evt.email_hash = (await sha256Hex('email:' + String(email).toLowerCase())).slice(0, 16);
    evt.ip_hash = (await sha256Hex('ip:' + ip)).slice(0, 16);
    console.log(JSON.stringify(evt));
  } catch { /* logging never breaks a request */ }
}

// Email validator — single source of truth for signup, login, reset-request, hub-sso.
function isValidEmail(s) {
  return typeof s === 'string' && s.length > 3 && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// Password length policy: min 10, max 200. Min enforces strength; max defends
// PBKDF2-100k DoS from attacker-controlled blob.
function isValidPassword(s) {
  return typeof s === 'string' && s.length >= 10 && s.length <= 200;
}

export default {
  // Any 5xx that leaves this worker fires an email beacon (alert.js) so a
  // real visitor hitting a server error is a same-minute email, not a
  // someday discovery in the logs.
  async fetch(request, env, ctx) {
    env = usableEnv(env);
    setAppBase(env);
    // A THROW out of handle() has to become a Response before the 5xx branch
    // below can see it. Without this catch the exception escaped the worker,
    // the runtime returned its own 500, and NO alert email was sent — silent on
    // exactly the crash class the beacon exists for.
    let response;
    let errDetail = '';
    try {
      response = await this.handle(request, env);
    } catch (e) {
      console.error('unhandled route error', request.method, new URL(request.url).pathname, (e && e.stack) || e);
      response = new Response(JSON.stringify({ error: 'Server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
      // The message the beacon reads comes off this body, so name the cause.
      errDetail = String((e && e.message) || e).slice(0, 200);
    }
    try {
      if (response && response.status >= 500) {
        // The message is read off a clone of the response body inside
        // waitUntil, so it never delays the client. Responses tagged by
        // markNoAlert() are skipped.
        const job = alertPayloadFor(request, response, errDetail)
          .then(info => (info ? reportServerError(env, null, info) : null))
          .catch(() => {});
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(job);
      }
    } catch { /* never block the response */ }
    return stripAlertHeader(response);
  },

  // Daily purge (wrangler.toml [triggers] crons). Retention promise: expired
  // rate-limit rows go, and reset / verification token hashes are deleted 7 days
  // after they expire (used ones expire too, so they go the same way).
  async scheduled(event, env, ctx) {
    env = usableEnv(env);
    setAppBase(env);
    ctx.waitUntil(purgeExpired(env));
  },

  async handle(request, env) {
    const cors = getCorsHeaders(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const p = url.pathname;

    // Pro entitlement: if X-Hub-Pro header present, verify it.
    const hubProToken = request.headers.get('X-Hub-Pro');
    let hubPro = null;
    if (hubProToken && env.HUB_JWT_SECRET) {
      hubPro = await verifyHubPro(hubProToken, env.HUB_JWT_SECRET);
    }

    if (!p.startsWith('/api/')) {
      // /reset/<token> is a virtual route: there is no asset at that path, so
      // ask ASSETS for the SPA shell instead. Without this the reset link 404s.
      const assetReq = /^\/reset\/[A-Za-z0-9._-]{16,256}\/?$/.test(p)
        ? new Request(new URL('/', request.url), request)
        : request;
      const asset = await env.ASSETS.fetch(assetReq);
      const headers = new Headers(asset.headers);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('X-Frame-Options', 'DENY');
      headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
      headers.set('Content-Security-Policy',
        "default-src 'self'; " +
        "script-src 'self' https://static.cloudflareinsights.com; " +
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
        "font-src 'self' https://fonts.gstatic.com data:; " +
        "img-src 'self' data: blob:; " +
        "connect-src 'self' https://cloudflareinsights.com; " +
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none';");
      headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=(), usb=()');
      headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      headers.set('Cache-Control', 'public, max-age=0, must-revalidate, no-cache');
      if (asset.status === 200 && request.method === 'GET' && APP_BASE && (headers.get('Content-Type') || '').includes('text/html')) {
        headers.delete('Content-Length');
        return withFooterYear(new Response(absoluteMeta(await asset.text(), APP_BASE), { status: 200, headers }));
      }
      return withFooterYear(new Response(asset.body, { status: asset.status, headers }));
    }

    // Reject oversized request bodies (64KB max)
    const contentLength = parseInt(request.headers.get('Content-Length') || '0');
    if (contentLength > 65536) {
      return res({ error: 'Request too large' }, 413, cors);
    }

    try {
      // A copy with no session secret can't log anyone in. Say so before any
      // account is written, instead of failing halfway with "Server error".
      if (p.startsWith('/api/auth/') && request.method === 'POST' && p !== '/api/auth/logout'
          && (typeof env.JWT_SECRET !== 'string' || env.JWT_SECRET.length < 32)) {
        console.error('JWT_SECRET is not set (or is shorter than 32 characters). Sign up and log in are off until it is.');
        return markNoAlert(res({ error: "This server isn't set up yet. Its owner needs to set JWT_SECRET to a random string of 32 or more characters.", code: 'setup_required' }, 503, cors));
      }

      // ── Rate-limit auth routes ──────────────────────────
      if (p.startsWith('/api/auth/') && request.method === 'POST' && p !== '/api/auth/logout') {
        const rl = await rateLimit(request, env, 'auth', 10, 300, undefined, cors);
        if (rl) return rl;
      }

      // ── CSRF: every state-changing request must come from our own pages ──
      // The session rides in a cookie the browser sends automatically, so
      // this runs on ALL POST/PUT/PATCH/DELETE, not a hand-picked list.
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && !CSRF_EXEMPT.has(p)) {
        const csrf = checkOrigin(request, cors);
        if (csrf) return csrf;
      }

      // ── Unauthenticated routes ──────────────────────────
      // Logout needs no valid session: it always clears the cookie, so a
      // stale or revoked cookie can still be removed.
      if (p === '/api/auth/logout'        && request.method === 'POST') return logout(cors);
      if (p === '/api/auth/signup'        && request.method === 'POST') return signup(request, env, cors);
      if (p === '/api/auth/login'         && request.method === 'POST') return login(request, env, cors);
      if (p === '/api/auth/hub-sso'       && request.method === 'POST') return hubSso(request, env, cors);
      if (p === '/api/auth/reset-request' && request.method === 'POST') return resetRequest(request, env, cors);
      if (p === '/api/auth/resend-verification' && request.method === 'POST') return resendVerification(request, env, cors);
      if (p === '/api/auth/resend-code'   && request.method === 'POST') return resendVerification(request, env, cors);
      if (p === '/api/auth/verify-code'   && request.method === 'POST') return verifyCode(request, env, cors);
      if (p === '/api/auth/reset-confirm' && request.method === 'POST') return resetConfirm(request, env, cors);
      if (p === '/api/auth/verify-email'  && request.method === 'GET')  return verifyEmail(url, env);

      // ── Feedback widget relay ───────────────────────────
      // The widget posts here, never straight to a webhook: 5 per IP per 10 min,
      // a honeypot, and type/length checks before anything is forwarded.
      if (p === '/api/feedback' && request.method === 'POST') {
        const rl = await rateLimit(request, env, 'feedback', 5, 600, undefined, cors);
        if (rl) return rl;
        return feedback(request, env, cors);
      }

      // ── Pro token refresh proxy ─────────────────────────
      // Trades a stale hub Pro token for a fresh one. Stripe renewals cap the
      // token exp at the billing period end, so a renewed subscriber's cached
      // token dies at renewal; the hub re-checks entitlement and re-mints.
      // The browser calls US (same-origin), we call the hub server-side and
      // pass its JSON + status straight through. On-demand only, never polled.
      if (p === '/api/pro-refresh' && request.method === 'POST') {
        const rl = await rateLimit(request, env, 'prorefresh', 30, 60, undefined, cors);
        if (rl) return rl;
        return proRefresh(request, env, cors);
      }

      // ── Recap stats for a Pro hub's weekly email (secret-gated, own auth) ──
      if (p === '/api/service/recap' && request.method === 'GET') return serviceRecap(url, request, env, cors);

      // ── Pro entitlement status ──────────────────────────
      if (p === '/api/pro-status' && request.method === 'GET') {
        // With a session presented, the token only counts for that account.
        if (hubPro && hasSession(request)) {
          try { hubPro = await bindHubPro(hubPro, await requireAuth(request, env, cors), env); } catch { hubPro = null; }
        }
        return res({
          is_pro: hasProAccess(hubPro),
          // False on a copy with no Pro hub: the page then points Go Pro at the hosted version.
          pro_available: !!env.HUB_JWT_SECRET,
          // With a hub: where Go Pro goes (UPGRADE_URL, null = hide Go Pro) and an optional price line.
          upgrade_url: UPGRADE_BASE || null,
          pro_price_text: (env.HUB_JWT_SECRET && String(env.PRO_PRICE_TEXT || '').trim()) || null,
          // False when FEEDBACK_WEBHOOK_URL is blank: the page then hides the Feedback button.
          feedback_available: !!env.FEEDBACK_WEBHOOK_URL,
          email: hubPro?.email || null,
          pro_until: hubPro?.pro_until || null,
        }, 200, cors);
      }

      // ── Authenticated routes ────────────────────────────
      const uid = await requireAuth(request, env, cors);
      hubPro = await bindHubPro(hubPro, uid, env);

      // Per-user write rate limit: 120 writes per minute per user
      if (['POST','PUT','DELETE','PATCH'].includes(request.method)) {
        const userRL = await rateLimit(request, env, '', 120, 60, `user:${uid}:writes`, cors);
        if (userRL) return userRL;
      }

      // GDPR data export — authed only
      if (p === '/api/account/export' && request.method === 'GET') return exportAccount(uid, env, cors);

      // Check-ins
      if (p === '/api/checkins' && request.method === 'GET')  return getCheckins(uid, url, env, hubPro, cors);
      if (p === '/api/checkins' && request.method === 'POST') return addCheckin(uid, request, env, cors);

      const ciMatch = p.match(/^\/api\/checkins\/([^/]+)$/);
      if (ciMatch && request.method === 'PUT')    return updateCheckin(uid, ciMatch[1], request, env, cors);
      if (ciMatch && request.method === 'DELETE')  return deleteCheckin(uid, ciMatch[1], env, cors);

      // Patterns
      if (p === '/api/patterns' && request.method === 'GET') return getPatterns(uid, env, hubPro, cors);

      // Recharge Menu
      if (p === '/api/recharge-menu' && request.method === 'GET') return getRechargeMenu(uid, env, hubPro, cors);

      // Profile & settings. /api/me is the boot check: the page can't read
      // the HttpOnly cookie, so one GET here decides "logged in?" (401 = no).
      if (p === '/api/me'            && request.method === 'GET')    return getProfile(uid, env, cors);
      if (p === '/api/profile'       && request.method === 'GET')    return getProfile(uid, env, cors);
      if (p === '/api/profile'       && request.method === 'PUT')    return updateProfile(uid, request, env, cors);
      if (p === '/api/auth/password' && request.method === 'PUT')    return changePassword(uid, request, env, cors);
      if (p === '/api/auth/account'  && request.method === 'DELETE') return deleteAccount(uid, request, env, cors);

      return res({ error: 'Not found' }, 404, cors);
    } catch (e) {
      if (e instanceof Response) return e;
      console.error(e.stack || e);
      return res({ error: 'Server error' }, 500, cors);
    }
  }
};

// Footer copyright year, filled in per request (never at module load, where a
// Worker's clock reads 1970). Every page marks the spot with <span data-year>.
function withFooterYear(response) {
  if (!(response.headers.get('Content-Type') || '').includes('text/html')) return response;
  const year = String(new Date().getUTCFullYear());
  return new HTMLRewriter().on('[data-year]', { element(el) { el.setInnerContent(year); } }).transform(response);
}

// ── Response helper ─────────────────────────────────────────────────────────

// CORS headers are passed explicitly per-request to avoid module-level mutable
// state racing between concurrent requests in the same Worker isolate.
function res(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// A request body as a plain object, or null. Anything else (null, a number, a
// string, an array, bad JSON) comes back null, so a route answers 400 instead
// of throwing a 500 on `null.email`.
async function readJson(request) {
  const b = await request.json().catch(() => null);
  return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
}

// ── Email footer ────────────────────────────────────────────────────────────
// Every email this Worker sends ends with the same footer. Put your own company
// name and postal address here (many countries require one in email). Use
// emailFooterHtml() in the html body and emailFooterText() at the end of the text body.
const EMAIL_SENDER_LINE = 'YOUR COMPANY NAME · YOUR BUSINESS ADDRESS';
const emailPrivacyUrl = () => `${APP_BASE}/legal/privacy`;
const emailFooterText = () => `${EMAIL_SENDER_LINE} · Privacy: ${emailPrivacyUrl()}`;
function emailFooterHtml(color = '#9BB3AE', rule = '#1C3035') {
  return `<p style="font-size:12px;color:${color};margin-top:24px;text-align:center;border-top:1px solid ${rule};padding-top:12px;line-height:1.5">${EMAIL_SENDER_LINE.replace(' · ', ' &middot; ')} &middot; Privacy: <a href="${emailPrivacyUrl()}" style="color:${color}">${emailPrivacyUrl()}</a></p>`;
}

// ── Email verification ──────────────────────────────────────────────────────

// Email a 6-digit CODE, not a magic link. A long tokenized verify-link to a
// young domain reads as phishing to Gmail, which accepts then silently drops
// it (Resend shows "delivered" but it never reaches the inbox). A code has no
// clickable credential link, so it lands normally. Store only the hash at rest.
async function sendVerificationEmail(userId, email, env) {
  const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  // Namespace the hash by user id. token is the PK; two users drawing the same
  // 6-digit code would otherwise collide on it and the 2nd INSERT would throw a
  // non-JSON 500 on signup. Prefixing with the user id makes every hash unique.
  const codeHash = await sha256Hex(userId + ':' + code);
  const now = Math.floor(Date.now() / 1000);
  // One live code per user: clear any prior unused codes first. Wrapped so a DB
  // hiccup logs and returns instead of bubbling a 500 out of signup.
  try {
    await env.DB.prepare('DELETE FROM email_verification_tokens WHERE user_id=? AND used=0').bind(userId).run();
    await env.DB.prepare('INSERT INTO email_verification_tokens (token, user_id, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)')
      .bind(codeHash, userId, now + 1800, now).run(); // 30-minute window
  } catch (e) {
    console.error('sendVerificationEmail: token store failed', e.message);
    return false;
  }
  // Returns true only when Resend accepted the message, so callers can tell
  // the user when nothing went out instead of promising an inbox.
  if (!env.RESEND_API_KEY) {
    // Local testing only: DEV_LOG_CODES=true prints the code when no email key is set.
    if (env.DEV_LOG_CODES === 'true') { console.log('[dev] verify code for', email, code); return true; }
    console.error('sendVerificationEmail: RESEND_API_KEY not set'); return false;
  }
  // Awaited so the send completes before the request ends (un-awaited fetches
  // get cancelled when the Worker returns). Errors logged, never thrown.
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.FROM_EMAIL || 'Energy Battery <onboarding@resend.dev>',
        to: email,
        subject: `Your Energy Battery code is ${code}`,
        text: `Your Energy Battery verification code is: ${code}\n\nEnter it on the sign-in screen to finish setting up your account. It expires in 30 minutes.\n\nIf you didn't sign up for Energy Battery, ignore this email.\n\n${emailFooterText()}`,
        html: emailLayout(EMAIL_THEME, {
          title: 'Your verification code',
          body: emailPara(EMAIL_THEME, 'Enter this code on the sign-in screen to finish setting up your Energy Battery account:')
            + emailCode(EMAIL_THEME, code)
            + emailSmall(EMAIL_THEME, "This code expires in 30 minutes. If you didn't sign up for Energy Battery, ignore this email."),
          footer: emailFooterHtml(EMAIL_THEME.muted, EMAIL_THEME.line),
        })
      })
    });
    if (!r.ok) { console.error('sendVerificationEmail: Resend FAIL', r.status, await r.text()); return false; }
    return true;
  } catch (e) { console.error('sendVerificationEmail threw', e.message); return false; }
}

// POST /api/auth/verify-code  body: { email, code, password } — finish email
// verification with the 6-digit code. Rate-limited (codes are low-entropy) and
// single-use. Sets the session cookie on success so the user is logged straight in.
// The password is required too: signup on an
// unverified row replaces its password, so without this a second signup could
// ride the real owner's code into an account whose password the attacker chose.
async function verifyCode(request, env, cors) {
  const csrf = checkOrigin(request, cors);
  if (csrf) return csrf;
  const { email, code, password } = (await readJson(request)) || {};
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanCode = String(code || '').replace(/\D/g, '');
  if (!isValidEmail(cleanEmail) || cleanCode.length !== 6) return res({ error: 'Enter the 6-digit code from your email.' }, 400, cors);
  if (typeof password !== 'string' || !password || password.length > 200) return res({ error: 'Enter your password along with the code.' }, 400, cors);
  // Throttle guesses: 8/min per email + 30/min per IP. 6-digit space + this = safe.
  const emailLimited = await rateLimit(request, env, 'verify-code', 8, 60, `verify-code:${cleanEmail}`, cors);
  if (emailLimited) return emailLimited;
  const ipLimited = await rateLimit(request, env, 'verify-code-ip', 30, 60, null, cors);
  if (ipLimited) return ipLimited;

  const user = await env.DB.prepare('SELECT id, email, email_verified, newsletter_consent, token_version, password_hash FROM users WHERE email = ?').bind(cleanEmail).first();
  if (!user) return res({ error: 'That code is invalid or expired.' }, 400, cors);
  // Already verified → DON'T issue a session (that would be a password-free
  // login bypass), and answer with the SAME 400 as an unknown address. A
  // distinct 409 "already verified" told anyone which emails have accounts
  //.
  if (user.email_verified) return res({ error: 'That code is invalid or expired.' }, 400, cors);
  // Wrong-code budget, only for a real unverified account, so junk requests
  // naming an address with no pending signup can't use it up. 20 misses a day
  // per account stops slow guessing from many networks. Each try is reserved
  // before the code is checked (so parallel guesses can't race past it) and a
  // right code hands its try back. Over budget answers the same generic 400.
  const dayKey = `verify-miss-day:${user.id}`;
  if (await overLimit(env, dayKey, 20, 86400)) return res({ error: 'That code is invalid or expired.' }, 400, cors);
  const codeHash = await sha256Hex(user.id + ':' + cleanCode);
  const legacyHash = await sha256Hex(cleanCode); // rows stored before the namespacing fix
  const now = Math.floor(Date.now() / 1000);
  // Match scoped to THIS user (user_id AND hash) — shared 6-digit codes collide otherwise.
  const row = await env.DB.prepare('SELECT token FROM email_verification_tokens WHERE user_id=? AND token IN (?,?) AND used=0 AND expires_at > ?')
    .bind(user.id, codeHash, legacyHash, now).first();
  if (!row) {
    try {
      // 5 misses burn the current code. The real owner just taps Resend code.
      if ((await hitCount(env, `verify-miss:${user.id}`, 1800)) >= 5) {
        await env.DB.prepare('UPDATE email_verification_tokens SET used=1 WHERE user_id=? AND used=0').bind(user.id).run();
      }
    } catch (e) { console.error('verify-miss count failed:', (e && e.message) || e); }
    return res({ error: 'That code is invalid or expired.' }, 400, cors);
  }
  await dropNewest(env, dayKey); // right code: not a miss
  // The code proves the inbox, the password proves this is whoever set the
  // row's credentials. Mismatch: nothing is marked verified, no session.
  if (!(await checkPw(password, user.password_hash))) return res({ error: "That password doesn't match this account." }, 400, cors);
  // Atomic and conditional: only verify if the row still has the exact hash
  // and token_version just checked (a parallel signup can't swap the password
  // in between) and the code is still unused (no double spend). If either
  // changed nothing, no session.
  const [upd, used] = await env.DB.batch([
    // The user row also needs the code to still be unused, so it can't be
    // verified without the consume on the next line.
    env.DB.prepare(`UPDATE users SET email_verified=1, verified_at=? WHERE id=? AND email_verified=0 AND password_hash=? AND COALESCE(token_version,0)=?
        AND EXISTS (SELECT 1 FROM email_verification_tokens WHERE user_id=? AND token=? AND used=0)`)
      .bind(new Date().toISOString(), user.id, user.password_hash, user.token_version ?? 0, user.id, row.token),
    env.DB.prepare('UPDATE email_verification_tokens SET used=1 WHERE user_id=? AND token=? AND used=0').bind(user.id, row.token),
  ]);
  if (!(upd?.meta?.changes > 0) || !(used?.meta?.changes > 0)) return res({ error: 'That code is invalid or expired.' }, 400, cors);
  // Any other live codes for this account are dead now too.
  await env.DB.prepare('UPDATE email_verification_tokens SET used=1 WHERE user_id=? AND used=0').bind(user.id).run();
  // Issue a session EXACTLY like login does.
  const token = await mintSession(user.id, user.token_version, env);
  const hubProToken = await hubProLookup(user.email, env);
  return resWithSession({ ...(hubProToken ? { hub_pro_token: hubProToken } : {}), user: { id: user.id, email: user.email, newsletter_consent: user.newsletter_consent === 1 } }, token, cors);
}

// Old GET /api/auth/verify-email?token=... from emailed links. Links stopped
// going out when 6-digit codes replaced them and every one has long expired,
// so this no longer touches the database. It used to verify any row whose
// token hash matched, with no password and no rate limit. Now it only points
// people to the code step.
async function verifyEmail(url, env) {
  const base = (APP_BASE || '/').replace(/"/g, '');
  return new Response(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Link expired</title><meta name="viewport" content="width=device-width,initial-scale=1"/><style>body{font-family:-apple-system,sans-serif;background:#16262A;color:#EEF5F3;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;padding:20px}a{color:#FF7F66}h1{color:#FF7F66}</style></head><body><main><h1>This link has expired</h1><p>Log in with your email and password. We'll email you a 6-digit code to finish setting up.</p><p><a href="${base}">Go to Energy Battery</a></p></main></body></html>`,
    { headers: { 'Content-Type': 'text/html;charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" } });
}

// ── Feedback relay ──────────────────────────────────────────────────────────

// Set FEEDBACK_WEBHOOK_URL to turn the feedback button on. Unset = off.
async function feedback(request, env, cors) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res({ error: 'Invalid request body.' }, 400, cors);
  // Honeypot: a hidden field people never see. Bots fill it; answer as if sent.
  if (body.website) return res({ ok: true }, 200, cors);
  if (!env.FEEDBACK_WEBHOOK_URL) return markNoAlert(res({ error: "Feedback isn't set up on this server." }, 503, cors));
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const message = str(body.message, 2000);
  if (message.length < 3) return res({ error: 'Please write a bit more so I know what you mean.' }, 400, cors);
  const email = str(body.email, 200);
  if (email && !isValidEmail(email)) return res({ error: "That email doesn't look right. Fix it or leave it blank." }, 400, cors);
  const type = ['bug', 'feature', 'other'].includes(body.type) ? body.type : 'other';
  const r = await fetch(env.FEEDBACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app: env.APP_NAME || 'Energy Battery',
      type,
      message,
      email,
      url: str(body.url, 500),
      user_agent: (request.headers.get('User-Agent') || '').slice(0, 500),
    }),
  }).catch(() => null);
  if (!r || !r.ok) return markNoAlert(res({ error: 'Could not send. Try again in a minute.' }, 502, cors));
  return res({ ok: true }, 200, cors);
}

// ── Scheduled purge ─────────────────────────────────────────────────────────

async function purgeExpired(env) {
  const now = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 86400;
  const out = await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM reset_tokens WHERE expires_at < ?').bind(new Date(weekAgo * 1000).toISOString()),
    env.DB.prepare('DELETE FROM email_verification_tokens WHERE expires_at < ?').bind(weekAgo),
    env.DB.prepare('DELETE FROM email_daily WHERE day < ?').bind(new Date(now * 1000).toISOString().slice(0, 10)),
  ]);
  console.log(JSON.stringify({ evt: 'purge', deleted: out.map(r => (r.meta && r.meta.changes) || 0) }));
}

// ── Pro-refresh proxy ───────────────────────────────────────────────────────

// POST /api/pro-refresh  body: {token} → the hub's refresh endpoint (PRO_REFRESH_URL).
// Hub contract: 200 {valid:true, token, pro_until} | 200 {valid:false} | 400 | 429.
// We pass the hub's JSON and status through untouched so the client sees the
// same shape regardless of which side rejected the token.
async function proRefresh(request, env, cors) {
  // Optional: PRO_REFRESH_URL is the hub's token refresh endpoint. Unset = off.
  if (!env.PRO_REFRESH_URL) return res({ valid: false, error: 'Pro refresh is off on this server.' }, 404, cors);
  const body = (await readJson(request)) || {};
  const token = body?.token;
  if (typeof token !== 'string' || !token || token.length > 2048) {
    return res({ valid: false }, 400, cors);
  }
  try {
    const r = await fetch(env.PRO_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await r.json().catch(() => null);
    if (data === null) return res({ valid: false }, 502, cors);
    return res(data, r.status, cors);
  } catch (e) {
    console.error('pro-refresh proxy failed', e.message);
    return res({ valid: false }, 502, cors);
  }
}

// ── Rate Limiting ───────────────────────────────────────────────────────────

// overLimit / hitCount live in ./lib/ratelimit.js (record-then-count in one D1
// batch, so parallel requests can't slip past a cap).
//
// Wrong-password lockout, keyed by account AND network: someone guessing at an
// address locks out their own network only, so the real owner (on another
// network) still gets in with the right password. Each try is recorded BEFORE
// the password check, and a correct password takes its own try back.
const LOGIN_LOCKOUT_MAX = 5;          // tries per account + network per window
const LOGIN_LOCKOUT_WINDOW_S = 900;   // 15 min
// Ceiling on wrong-password tries against ONE account from every network added
// together, so guessing spread across many networks stays slow. Above one
// network's 5 so a single guesser can't lock the owner out, and a password
// reset always gets the owner back in.
const LOGIN_ALL_MAX = 20;
const lockKeyFor = (email, request) => `failed-login:${email}|${ipKey(request)}`;
const lockedOut = (cors) => res({ error: 'Too many failed attempts. Try again in 15 minutes, or use Forgot password to get back in now.' }, 429, { ...cors, 'Retry-After': String(LOGIN_LOCKOUT_WINDOW_S) });
// True when this try is over a lockout cap. Call BEFORE checking the password.
async function passwordTryRefused(env, email, request) {
  return (await overLimit(env, lockKeyFor(email, request), LOGIN_LOCKOUT_MAX, LOGIN_LOCKOUT_WINDOW_S))
    || (await overLimit(env, `failed-login-all:${email}`, LOGIN_ALL_MAX, LOGIN_LOCKOUT_WINDOW_S));
}
// A right password hands its try back to both counters.
async function passwordTryOk(env, email, request) {
  await dropNewest(env, lockKeyFor(email, request));
  await dropNewest(env, `failed-login-all:${email}`);
}
// Every wrong-password count for one account, from every network.
async function clearPasswordTries(env, email) {
  try {
    const prefix = 'failed-login:' + email + '|';
    await env.DB.prepare('DELETE FROM rate_limits WHERE substr(key, 1, ?) = ? OR key = ?')
      .bind(prefix.length, prefix, 'failed-login-all:' + email).run();
  } catch (e) { console.error('lock clear failed:', (e && e.message) || e); }
}

// Mail caps. Per-IP limits alone let a
// botnet, or one person rotating IPs, make this app mail any address over and
// over, burning the Resend quota and the sending domain's reputation.
// Two daily buckets so signup spam can't use up the password resets.
const MAIL_DAILY = { 'verify-mail': 150, 'reset-mail': 150 };
// Per-address: at most 3 emails per 15 min to one address.
const MAIL_PER_ADDRESS = 3;
const MAIL_PER_ADDRESS_WINDOW = 900;
// And at most 10 a day to one address, so nobody's inbox can be filled slowly.
const MAIL_PER_ADDRESS_DAY = 10;

// Called ONLY when an email is about to go to an existing account, never
// before the account lookup, so junk or unknown addresses can't spend anyone's
// budget. Both caps count real sends only. When either is hit the caller
// skips the send and answers exactly as it would after a normal send, so the
// cap never reveals anything. The per-address slot is taken and counted in one
// batch, and the daily room check and charge are one atomic upsert, so a burst
// of parallel requests can't get past either. A send the daily ceiling stops
// gives its per-address slot back.
async function mailAllowed(env, addrKey, bucket) {
  const now = Math.floor(Date.now() / 1000);
  if (await overLimit(env, addrKey, MAIL_PER_ADDRESS, MAIL_PER_ADDRESS_WINDOW)) {
    console.log(JSON.stringify({ evt: 'mail_skipped', reason: 'per_address', bucket }));
    return false;
  }
  if (await overLimit(env, `${addrKey}|day`, MAIL_PER_ADDRESS_DAY, 86400)) {
    await dropNewest(env, addrKey);
    console.log(JSON.stringify({ evt: 'mail_skipped', reason: 'per_address_day', bucket }));
    return false;
  }
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const row = await env.DB.prepare(
    'INSERT INTO email_daily (k, day, n) VALUES (?, ?, 1) ON CONFLICT(k, day) DO UPDATE SET n = n + 1 RETURNING n'
  ).bind(bucket, day).first();
  const n = row && typeof row.n === 'number' ? row.n : 0;
  if (n > MAIL_DAILY[bucket]) {
    await dropNewest(env, addrKey);
    await dropNewest(env, `${addrKey}|day`);
    console.log(JSON.stringify({ evt: 'mail_skipped', reason: 'daily_ceiling', bucket, n }));
    return false;
  }
  return true;
}

// One cap, keyed by `customKey` or by `prefix` + the caller's network.
// Returns null when the request may go on, or the 429 to send back.
async function rateLimit(request, env, prefix, maxAttempts, windowSecs, customKey, cors = {}) {
  const key = customKey || `${prefix}:${ipKey(request)}`;
  if (!(await overLimit(env, key, maxAttempts, windowSecs))) return null;
  return res({ error: 'Too many attempts. Please try again later.' }, 429, { ...cors, 'Retry-After': String(windowSecs) });
}

// ── Crypto: PBKDF2 password hashing ─────────────────────────────────────────

async function hashPw(pw) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltHex = [...salt].map(b => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  const hashHex = [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function checkPw(pw, stored) {
  const [, saltHex, hashHex] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return timingSafeEqualStr([...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join(''), hashHex);
}

// ── Crypto: HS256 JWT ────────────────────────────────────────────────────────

function b64(str) { return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, ''); }
function unb64(str) { const p = str.replace(/-/g, '+').replace(/_/g, '/'); return atob(p + '='.repeat((4 - p.length % 4) % 4)); }

function requireSecret(secret) {
  // Refuse to sign or check logins without a real secret. A missing one would turn
  // into the word 'undefined', and anyone could forge a session.
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('JWT_SECRET must be set to a random string of 32+ characters.');
}

async function makeJWT(payload, secret) {
  requireSecret(secret);
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return `${data}.${b64(String.fromCharCode(...new Uint8Array(sig)))}`;
}

// A malformed token (bad base64 or JSON) is just an invalid token. It must get a
// 401, not a 500: every 500 fires the optional alert webhook.
async function verifyJWT(token, secret) {
  try { return await verifyJWTStrict(token, secret); } catch { return null; }
}

async function verifyJWTStrict(token, secret) {
  requireSecret(secret);
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('HMAC', key,
    Uint8Array.from(unb64(s), c => c.charCodeAt(0)),
    new TextEncoder().encode(`${h}.${p}`)
  );
  if (!valid) return null;
  const payload = JSON.parse(unb64(p));
  if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
  return payload;
}

// ── Auth middleware ──────────────────────────────────────────────────────────

async function requireAuth(request, env, cors = {}) {
  // Session cookie only. The old localStorage `Authorization: Bearer` path
  // is gone, so a Bearer header alone is a 401.
  const cookieJwt = readCookie(request, SESSION_COOKIE);
  if (!cookieJwt) throw res({ error: 'Unauthorized' }, 401, cors);
  const payload = await verifyJWT(cookieJwt, env.JWT_SECRET);
  if (!payload || typeof payload.sub !== 'string') throw res({ error: 'Invalid or expired token' }, 401, cors);
  if (payload.tv !== undefined) {
    const user = await env.DB.prepare('SELECT token_version FROM users WHERE id=?').bind(payload.sub).first();
    if (!user || (user.token_version ?? 0) !== payload.tv) throw res({ error: 'Token revoked' }, 401, cors);
  }
  return payload.sub;
}

// POST /api/auth/logout: clears the cookie. Energy Battery keeps no
// server-side session list, so there is nothing else to revoke here; a
// password change or reset still ends every session via token_version.
function logout(cors) {
  const r = res({ ok: true }, 200, cors);
  r.headers.append('Set-Cookie', clearSessionCookie());
  return r;
}

// ── Auth routes ──────────────────────────────────────────────────────────────

async function signup(request, env, cors) {
  const reqBody = await readJson(request);
  if (!reqBody || typeof reqBody !== 'object') return res({ error: 'Invalid request body.' }, 400, cors);
  const { email, password, newsletter_consent = false } = reqBody;
  const emailNorm = String(email || '').trim().toLowerCase();
  if (!isValidEmail(emailNorm)) {
    return res({ error: 'Valid email required' }, 400, cors);
  }
  if (!isValidPassword(password)) {
    return res({ error: 'Password must be 10-200 characters.' }, 400, cors);
  }
  // Signups: 20 a day per network, so one network can't spend the whole shared
  // daily mail budget on junk addresses. Checked before the account lookup, so
  // the answer is the same for an address that has an account and one that doesn't.
  const dayLimited = await rateLimit(request, env, 'signup-day', 20, 86400, undefined, cors);
  if (dayLimited) return dayLimited;
  const existing = await env.DB.prepare('SELECT id, email_verified FROM users WHERE email = ?').bind(emailNorm).first();
  if (existing) {
    if (!existing.email_verified) {
      // Nobody has proved they own this address yet. The newest signer-up
      // takes over the credentials and gets a fresh code; entering it is what
      // proves ownership. Before this, a row squatted by someone else kept ITS
      // password after the real owner verified (pre-hijack account takeover).
      const hash = await hashPw(password);
      await env.DB.prepare('UPDATE users SET password_hash=?, token_version=COALESCE(token_version,0)+1 WHERE id=?').bind(hash, existing.id).run();
      // Over a mail cap: skip the send, answer as if sent (resend works later).
      const sent = (await mailAllowed(env, `verify-mail:${emailNorm}`, 'verify-mail'))
        ? await sendVerificationEmail(existing.id, emailNorm, env) : true;
      return res({ ok: true, awaiting_verification: true, email: emailNorm, email_sent: sent, message: 'Check your inbox to verify your email before logging in.' }, 200, cors);
    }
    // Don't leak account existence. Burn PBKDF2 cycles to match timing and
    // answer with the exact shape of a fresh signup.
    await hashPw(password);
    return res({ ok: true, awaiting_verification: true, email: emailNorm, email_sent: true, message: 'Check your inbox to verify your email before logging in.' }, 200, cors);
  }

  const id = crypto.randomUUID();
  const hash = await hashPw(password);
  const now = new Date().toISOString();
  await env.DB.prepare(
    'INSERT INTO users (id,email,password_hash,newsletter_consent,newsletter_consent_at,timezone,created_at) VALUES (?,?,?,?,?,?,?)'
  ).bind(id, emailNorm, hash, newsletter_consent ? 1 : 0, newsletter_consent ? now : null, 'America/New_York', now).run();

  const emailSent = (await mailAllowed(env, `verify-mail:${emailNorm}`, 'verify-mail'))
    ? await sendVerificationEmail(id, emailNorm, env) : true;
  // Optional operator ping on each signup (SIGNUP_WEBHOOK_URL). Off when unset.
  await notifySignup(env, 'energy-battery', emailNorm, newsletter_consent === true);

  return res({ ok: true, awaiting_verification: true, email: emailNorm, email_sent: emailSent, message: 'Check your inbox to verify your email before logging in.' }, 200, cors);
}

async function resendVerification(request, env, cors) {
  const { email } = (await readJson(request)) || {};
  if (!email) return res({ ok: true }, 200, cors);
  const emailLower = String(email).trim().toLowerCase();
  if (!isValidEmail(emailLower)) return res({ ok: true }, 200, cors);
  const emailLimited = await rateLimit(request, env, 'verify-resend', 1, 60, `verify-resend:${emailLower}`, cors);
  if (emailLimited) return emailLimited;
  const ipLimited = await rateLimit(request, env, 'verify-resend-ip', 10, 60, null, cors);
  if (ipLimited) return ipLimited;
  const user = await env.DB.prepare('SELECT id, email_verified FROM users WHERE email = ?').bind(emailLower).first();
  // An unknown or already-verified email still reads as sent (no enumeration);
  // only a real send that Resend refused reports email_sent:false.
  let emailSent = true;
  // Same caps as signup; over one, the send is skipped and the answer is unchanged.
  if (user && !user.email_verified && await mailAllowed(env, `verify-mail:${emailLower}`, 'verify-mail')) {
    emailSent = await sendVerificationEmail(user.id, emailLower, env);
  }
  return res({ ok: true, email_sent: emailSent, message: 'If that account exists and needs verification, an email has been sent.' }, 200, cors);
}

// Optional signup notification to the operator. Set SIGNUP_WEBHOOK_URL and
// SIGNUP_WEBHOOK_SECRET to get a POST on each signup (the secret rides in the
// X-Signup-Secret header). Must be awaited: an un-awaited fetch is cancelled when
// the response returns.
async function notifySignup(env, appName, email, appNewsletterConsent) {
  if (!env.SIGNUP_WEBHOOK_URL || !env.SIGNUP_WEBHOOK_SECRET) return;
  await fetch(env.SIGNUP_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Signup-Secret': env.SIGNUP_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      app_name: appName,
      email: (email || '').toLowerCase(),
      app_newsletter_consent: !!appNewsletterConsent,
      ss_newsletter_consent: false,
      timestamp: new Date().toISOString(),
    }),
  }).catch(() => {});
}

// Hub SSO: verify hub Pro JWT locally with HUB_JWT_SECRET, find-or-create the
// user, mint a Battery session JWT. Auto-created users get a random sentinel
// password_hash and can set a real password via forgot-password later.
async function hubSso(request, env, cors) {
  const body = (await readJson(request)) || {};
  const hubJwt = body.hub_pro_jwt;
  if (!hubJwt || typeof hubJwt !== 'string' || hubJwt.length > 4096) {
    return res({ error: 'Missing hub token' }, 400, cors);
  }
  if (!env.HUB_JWT_SECRET) return res({ error: 'Hub sign-in is off on this server.' }, 404, cors);
  const payload = await verifyHubPro(hubJwt, env.HUB_JWT_SECRET);
  if (!payload || !payload.email) {
    return res({ error: 'Invalid or expired hub token' }, 401, cors);
  }
  const emailLower = String(payload.email).trim().toLowerCase();
  if (!isValidEmail(emailLower)) {
    return res({ error: 'Invalid hub token email' }, 401, cors);
  }
  let user = await env.DB.prepare(
    'SELECT id, email, newsletter_consent, token_version, email_verified FROM users WHERE email = ?'
  ).bind(emailLower).first();

  // A hub-verified user with no usable password: the sentinel never matches,
  // so "Forgot password" is the only way to set one.
  const randomSentinel = () => {
    const randSalt = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    const randHash = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
    return `pbkdf2:${randSalt}:${randHash}`;
  };
  if (user && !user.email_verified) {
    // The hub proved this email. Whoever set the row's password never did, so
    // that password is dropped and its sessions are revoked along with it.
    await env.DB.prepare('UPDATE users SET email_verified=1, verified_at=COALESCE(verified_at, ?), password_hash=?, token_version=COALESCE(token_version,0)+1 WHERE id=?')
      .bind(new Date().toISOString(), randomSentinel(), user.id).run();
    user.token_version = (user.token_version ?? 0) + 1;
  }

  if (!user) {
    const id = crypto.randomUUID();
    const sentinel = randomSentinel();
    const now = new Date().toISOString();
    await env.DB.prepare(
      'INSERT INTO users (id, email, password_hash, newsletter_consent, timezone, created_at, email_verified, verified_at) VALUES (?, ?, ?, 0, ?, ?, 1, ?)'
    ).bind(id, emailLower, sentinel, 'America/New_York', now, now).run();
    user = { id, email: emailLower, newsletter_consent: 0, token_version: 0 };
  }

  const token = await mintSession(user.id, user.token_version, env);
  await logAuth('login_ok', request, { uid: user.id });
  return resWithSession({
    user: { id: user.id, email: user.email, newsletter_consent: user.newsletter_consent === 1 },
  }, token, cors);
}

async function login(request, env, cors) {
  const reqBody = await readJson(request);
  if (!reqBody || typeof reqBody !== 'object') return res({ error: 'Invalid request body.' }, 400, cors);
  const { email, password } = reqBody;
  const emailLower = String(email || '').trim().toLowerCase();
  if (!isValidEmail(emailLower)) {
    return res({ error: 'Valid email required' }, 400, cors);
  }
  if (!isValidPassword(password)) {
    return res({ error: 'Password must be 10-200 characters.' }, 400, cors);
  }
  const DUMMY_HASH = 'pbkdf2:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000';
  // Wrong-password lockout (see Rate Limiting). The try is recorded before the
  // password check, so parallel guesses can't race past it. It is keyed by the
  // address typed, whether or not an account exists, so it reveals nothing.
  if (await passwordTryRefused(env, emailLower, request)) {
    await logAuth('login_fail', request, { email: emailLower });
    return lockedOut(cors);
  }
  // Explicit column list — no SELECT * to avoid future-column leak.
  const user = await env.DB.prepare(
    'SELECT id, email, password_hash, token_version, newsletter_consent, email_verified FROM users WHERE email = ?'
  ).bind(emailLower).first();
  const storedHash = user?.password_hash || DUMMY_HASH;
  const pwValid = await checkPw(password, storedHash);
  if (!user || !pwValid) {
    await logAuth('login_fail', request, { email: emailLower });
    return res({ error: 'Invalid email or password' }, 401, cors);
  }
  // Right password: take this try back out of both counters.
  await passwordTryOk(env, emailLower, request);
  if (!user.email_verified) {
    return res({ error: 'Please verify your email before logging in.', code: 'email_not_verified', email: user.email }, 403, cors);
  }
  const token = await mintSession(user.id, user.token_version, env);
  await logAuth('login_ok', request, { uid: user.id });
  const hubProToken = await hubProLookup(user.email, env);
  return resWithSession({ ...(hubProToken ? { hub_pro_token: hubProToken } : {}), user: { id: user.id, email: user.email, newsletter_consent: user.newsletter_consent === 1 } }, token, cors);
}

// Pro follows the account, not the browser. At login, ask the hub whether
// this email has Pro and carry a fresh hub token back in the login response —
// otherwise a new device/cleared storage stays free until the user thinks to
// relaunch from the hub. Never blocks login: any failure → null.
async function hubProLookup(email, env) {
  // Optional: PRO_LOOKUP_URL + HUB_LOOKUP_SECRET connect a Pro hub. Unset = free plan for everyone.
  if (!env.PRO_LOOKUP_URL || !env.HUB_LOOKUP_SECRET) return null;
  try {
    const r = await fetch(env.PRO_LOOKUP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': env.HUB_LOOKUP_SECRET },
      body: JSON.stringify({ email, app: 'energy-battery' }),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j && j.pro === true && typeof j.token === 'string' ? j.token : null;
  } catch (e) {
    console.error('hubProLookup failed', e.message);
    return null;
  }
}

async function resetRequest(request, env, cors) {
  const { email } = (await readJson(request)) || {};
  const emailLower = String(email || '').trim().toLowerCase();
  // Always 200 to avoid email enumeration via reset.
  if (!isValidEmail(emailLower)) return res({ success: true }, 200, cors);
  const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(emailLower).first();
  if (!user) return res({ success: true }, 200, cors);
  // Per-address cap + daily reset ceiling, charged only for a real send. Over
  // either one: nothing is sent and the answer is the same generic success.
  if (!(await mailAllowed(env, `reset-email:${emailLower}`, 'reset-mail'))) return res({ success: true }, 200, cors);

  const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
  const tokenHash = await sha256Hex(token);
  const expires = new Date(Date.now() + 3600000).toISOString();
  // Store hashed token at rest. Email contains unhashed token.
  await env.DB.prepare('INSERT OR REPLACE INTO reset_tokens (token,user_id,expires_at,used) VALUES (?,?,?,0)')
    .bind(tokenHash, user.id, expires).run();

  if (!env.RESEND_API_KEY && env.DEV_LOG_CODES === 'true') console.log('[dev] reset link:', `${APP_BASE}/reset/${token}`);
  if (env.RESEND_API_KEY) {
    // /reset/<token>, NOT ?reset=<token>. Mail transfer agents quoted-printable
    // encode the body, and the "=" of a query string is the QP escape character:
    // the link arrives with the "=" and the next two characters replaced by a
    // control byte, so the token is corrupted and the user can never get back
    // in. Seen on a real delivered email:
    //   sent    https://example.com/?reset=1a2b00f74d...
    //   arrived https://example.com?reset\x041a00f74d...
    // A path segment has no "=" for QP to eat.
    const resetUrl = `${APP_BASE}/reset/${token}`;
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.FROM_EMAIL || 'Energy Battery <onboarding@resend.dev>',
        to: emailLower,
        subject: 'Reset your Energy Battery password',
        text: `Reset your Energy Battery password\n\nOpen this link to reset your password. It expires in 1 hour.\n${resetUrl}\n\nIf you didn't request this, ignore this email.\n\n${emailFooterText()}`,
        html: emailLayout(EMAIL_THEME, {
          title: 'Reset your password',
          body: emailPara(EMAIL_THEME, 'Tap below to reset your Energy Battery password. This link expires in 1 hour.')
            + emailButton(EMAIL_THEME, resetUrl, 'Reset password')
            + emailSmall(EMAIL_THEME, "If you didn't request this, ignore this email."),
          footer: emailFooterHtml(EMAIL_THEME.muted, EMAIL_THEME.line),
        })
      })
    });
  }
  return res({ success: true }, 200, cors);
}

async function resetConfirm(request, env, cors) {
  const reqBody = await readJson(request);
  if (!reqBody || typeof reqBody !== 'object') return res({ error: 'Invalid request body.' }, 400, cors);
  const { token, password } = reqBody;
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) return res({ error: 'Invalid or expired reset link' }, 400, cors);
  if (!isValidPassword(password)) {
    return res({ error: 'Password must be 10-200 characters.' }, 400, cors);
  }
  const tokenHash = await sha256Hex(token);
  // Explicit columns — no SELECT *.
  const rt = await env.DB.prepare(
    'SELECT token, user_id, expires_at, used FROM reset_tokens WHERE token=? AND used=0'
  ).bind(tokenHash).first();
  if (!rt || new Date(rt.expires_at) < new Date()) {
    return res({ error: 'Invalid or expired reset link' }, 400, cors);
  }
  const hash = await hashPw(password);
  // Claim the link in one statement: two requests racing with the same link
  // can't both get through. Then every other reset link for this user dies too.
  const claim = await env.DB.prepare('UPDATE reset_tokens SET used=1 WHERE token=? AND used=0').bind(tokenHash).run();
  if (!claim || !claim.meta || !claim.meta.changes) return res({ error: 'Invalid or expired reset link' }, 400, cors);
  await env.DB.batch([
    // Opening the emailed link proved the inbox, so the account is verified too.
    env.DB.prepare('UPDATE users SET password_hash=?, token_version=COALESCE(token_version,0)+1, email_verified=1, verified_at=COALESCE(verified_at, ?) WHERE id=?').bind(hash, new Date().toISOString(), rt.user_id),
    env.DB.prepare('UPDATE reset_tokens SET used=1 WHERE user_id=?').bind(rt.user_id),
    env.DB.prepare('UPDATE email_verification_tokens SET used=1 WHERE user_id=?').bind(rt.user_id),
  ]);
  const user = await env.DB.prepare('SELECT id,email,newsletter_consent,token_version FROM users WHERE id=?').bind(rt.user_id).first();
  if (!user) return res({ error: 'Invalid or expired reset link' }, 400, cors);
  // The owner proved the inbox, so earlier wrong-password counts are cleared.
  await clearPasswordTries(env, String(user.email).toLowerCase());
  await logAuth('password_reset', request, { uid: user.id });
  const jwt = await mintSession(user.id, user.token_version, env);
  const hubProToken = await hubProLookup(user.email, env);
  return resWithSession({ ...(hubProToken ? { hub_pro_token: hubProToken } : {}), user: { id: user.id, email: user.email, newsletter_consent: user.newsletter_consent === 1 } }, jwt, cors);
}

// ── Profile routes ──────────────────────────────────────────────────────────

async function getProfile(uid, env, cors) {
  const u = await env.DB.prepare('SELECT id,email,timezone,newsletter_consent,track_focus FROM users WHERE id=?').bind(uid).first();
  if (!u) return res({ error: 'Not found' }, 404, cors);
  return res({ id: u.id, email: u.email, timezone: u.timezone, newsletter_consent: u.newsletter_consent === 1, track_focus: parseTrackFocus(u.track_focus) }, 200, cors);
}

// "What do you want to track?" from onboarding (migrations/0004_track_focus.sql).
// Stored as a JSON array of these four keys only, so the column can never hold
// anything the client didn't offer. NULL means the question was never answered.
const TRACK_FOCUS = ['work', 'sleep', 'food', 'people'];
function validTrackFocus(v) {
  return Array.isArray(v) && v.length <= TRACK_FOCUS.length && v.every((k) => typeof k === 'string' && TRACK_FOCUS.includes(k));
}
function parseTrackFocus(raw) {
  if (raw == null) return null;
  try { const v = JSON.parse(raw); return validTrackFocus(v) ? v : null; } catch { return null; }
}

// The stored zone decides which calendar day a check-in belongs to and what
// "today" means for the streak, so it has to be a real IANA id. Anything else
// silently degrades to UTC inside todayInTz() and quietly breaks the streak for
// that user. Intl throws on an unknown zone, which is the check.
function validTimezone(v) {
  if (typeof v !== 'string' || v.length < 3 || v.length > 64) return false;
  if (!/^[A-Za-z0-9+_\-]+(\/[A-Za-z0-9+_\-]+){0,2}$/.test(v)) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: v }); return true; } catch { return false; }
}

async function updateProfile(uid, request, env, cors) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return res({ error: 'Invalid request body.' }, 400, cors);
  const sets = [], vals = [];
  if ('timezone' in body) {
    if (!validTimezone(body.timezone)) return res({ error: 'Invalid timezone' }, 400, cors);
    sets.push('timezone=?'); vals.push(body.timezone);
  }
  if ('track_focus' in body) {
    if (!validTrackFocus(body.track_focus)) return res({ error: 'Pick from work, sleep, food and people.' }, 400, cors);
    sets.push('track_focus=?'); vals.push(JSON.stringify(TRACK_FOCUS.filter((k) => body.track_focus.includes(k))));
  }
  if ('newsletter_consent' in body) {
    sets.push('newsletter_consent=?'); vals.push(body.newsletter_consent ? 1 : 0);
    sets.push('newsletter_consent_at=?'); vals.push(body.newsletter_consent ? new Date().toISOString() : null);
  }
  if (sets.length) await env.DB.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).bind(...vals, uid).run();
  return res({ success: true }, 200, cors);
}

async function changePassword(uid, request, env, cors) {
  const reqBody = await readJson(request);
  if (!reqBody || typeof reqBody !== 'object') return res({ error: 'Invalid request body.' }, 400, cors);
  const { current_password, password } = reqBody;
  if (typeof current_password !== 'string' || !current_password || current_password.length > 200) return res({ error: 'Current password required' }, 400, cors);
  if (!isValidPassword(password)) {
    return res({ error: 'New password must be 10-200 characters.' }, 400, cors);
  }
  const user = await env.DB.prepare('SELECT email, password_hash FROM users WHERE id=?').bind(uid).first();
  if (!user) return res({ error: 'Not found' }, 404, cors);
  // Shares the login lockout, so a stolen session can't be used to guess the password.
  const emailLower = String(user.email).toLowerCase();
  if (await passwordTryRefused(env, emailLower, request)) return lockedOut(cors);
  if (!await checkPw(current_password, user.password_hash)) {
    return res({ error: 'Current password is incorrect' }, 401, cors);
  }
  await passwordTryOk(env, emailLower, request);
  await env.DB.prepare('UPDATE users SET password_hash=?, token_version=COALESCE(token_version,0)+1 WHERE id=?').bind(await hashPw(password), uid).run();
  await logAuth('password_change', request, { uid });
  return res({ success: true }, 200, cors);
}

// Account delete needs a fresh proof, so a stolen JWT alone can't wipe data.
// Two proofs are accepted, either one is enough:
//   - current_password, for any account that has one;
//   - hub_pro_jwt plus confirm:"DELETE", for accounts made through the App Hub
//     that never set a password (their hash is a random sentinel nobody can
//     type). The hub token is checked here with HUB_JWT_SECRET and must name
//     this account's email: the same proof hub-sso accepts to log in.
async function deleteAccount(uid, request, env, cors) {
  const body = await readJson(request);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res({ error: 'Invalid request body.' }, 400, cors);
  const user = await env.DB.prepare('SELECT email, password_hash FROM users WHERE id=?').bind(uid).first();
  if (!user) return res({ error: 'Not found' }, 404, cors);
  if (body.hub_pro_jwt !== undefined) {
    if (body.confirm !== 'DELETE') return res({ error: 'Type DELETE to confirm.' }, 400, cors);
    const hub = typeof body.hub_pro_jwt === 'string' && body.hub_pro_jwt.length <= 4096 && env.HUB_JWT_SECRET
      ? await verifyHubPro(body.hub_pro_jwt, env.HUB_JWT_SECRET) : null;
    if (!hub || String(hub.email || '').toLowerCase() !== String(user.email).toLowerCase()) {
      return res({ error: "We couldn't confirm your App Hub sign-in. Open the App Hub, launch Energy Battery from there, then try again. Or use Forgot password to set a password first." }, 401, cors);
    }
  } else {
    const currentPassword = body.current_password;
    if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 200) {
      return res({ error: 'Password required to delete account' }, 400, cors);
    }
    // Shares the login lockout, so a stolen session can't be used to guess the password.
    if (await passwordTryRefused(env, String(user.email).toLowerCase(), request)) return lockedOut(cors);
    if (!await checkPw(currentPassword, user.password_hash)) {
      return res({ error: 'Password is incorrect' }, 401, cors);
    }
  }
  await clearPasswordTries(env, String(user.email).toLowerCase());
  await env.DB.batch([
    env.DB.prepare('DELETE FROM checkins WHERE user_id=?').bind(uid),
    env.DB.prepare('DELETE FROM reset_tokens WHERE user_id=?').bind(uid),
    env.DB.prepare('DELETE FROM email_verification_tokens WHERE user_id=?').bind(uid),
    env.DB.prepare('DELETE FROM users WHERE id=?').bind(uid),
  ]);
  await logAuth('account_delete', request, { uid });
  const out = res({ success: true }, 200, cors);
  out.headers.append('Set-Cookie', clearSessionCookie());
  return out;
}

// GDPR Right-to-Access: authed export of all user data as JSON.
async function exportAccount(uid, env, cors) {
  const user = await env.DB.prepare(
    'SELECT id, email, timezone, track_focus, newsletter_consent, newsletter_consent_at, email_verified, verified_at, created_at FROM users WHERE id=?'
  ).bind(uid).first();
  if (!user) return res({ error: 'Not found' }, 404, cors);
  const checkins = await env.DB.prepare(
    'SELECT id, energy_level, time_of_day, tags, charged_by, drained_by, note, checkin_date, created_at FROM checkins WHERE user_id=?'
  ).bind(uid).all();
  return res({
    exported_at: new Date().toISOString(),
    user,
    checkins: checkins.results || [],
  }, 200, cors);
}

// ── Check-in routes ─────────────────────────────────────────────────────────

async function getCheckins(uid, url, env, hubPro, cors) {
  let days = parseInt(url.searchParams.get('days')) || 90;
  const isPro = hasProAccess(hubPro);
  // Free tier: cap window at 7 days regardless of requested days param
  if (!isPro) days = Math.min(days, 7);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  // Explicit columns — no SELECT * to avoid future-column leak.
  const r = await env.DB.prepare(
    'SELECT id, energy_level, time_of_day, tags, charged_by, drained_by, note, checkin_date, created_at FROM checkins WHERE user_id=? AND checkin_date>=? ORDER BY checkin_date DESC, created_at DESC'
  ).bind(uid, since).all();
  // Streak + total check-ins are FREE stats (the header shows them to everyone;
  // Patterns is the Pro feature). Computed over ALL check-in dates, not the
  // possibly-7-day items window, using "today" in the user's own timezone.
  const u = await env.DB.prepare('SELECT timezone FROM users WHERE id=?').bind(uid).first();
  const dates = await env.DB.prepare(
    'SELECT DISTINCT checkin_date FROM checkins WHERE user_id=? ORDER BY checkin_date DESC'
  ).bind(uid).all();
  const totals = await env.DB.prepare('SELECT COUNT(*) as c FROM checkins WHERE user_id=?').bind(uid).first();
  return res({
    items: r.results || [],
    pro_filtered: !isPro,
    ...(() => { const s = calcStreakInfo((dates.results || []).map(d => d.checkin_date), todayInTz(u?.timezone));
      return { current_streak: s.streak, backup: { ready: s.ready, used_on: s.used_on, recharges_on: s.recharges_on } }; })(),
    total_checkins: totals?.c || 0,
  }, 200, cors);
}

// The 12 tag pills the client offers. Anything else is rejected so a stored
// tag can never be a prototype key or a 50-char blob.
const VALID_TAGS = new Set(['exercise', 'sleep', 'food', 'work', 'social', 'outdoors', 'creative', 'rest', 'caffeine', 'alcohol', 'screen_time', 'meditation']);
function validTags(tags) {
  return Array.isArray(tags) && tags.length <= 20 && tags.every((t) => typeof t === 'string' && VALID_TAGS.has(t));
}

// How far back a check-in may be backdated. The form offers 30 days; the Worker
// allows 31 so a user whose timezone is a day off the server's never gets a 400
// on the oldest day the picker let them choose.
const MAX_BACKFILL_DAYS = 31;

const dayShift = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

// Checked against UTC today with a day of slack on the future side, which
// covers every timezone without reading the user's. Without a window, a typo or
// a hand-rolled request could park a check-in in 1970 or the year 3000 and
// quietly wreck the streak and the pattern averages. String comparison is safe
// here: the format is fixed-width ISO, so it sorts chronologically, and
// impossible dates like 2026-13-45 fall outside the window on their own.
function validCheckinDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const today = new Date().toISOString().slice(0, 10);
  return v >= dayShift(today, -MAX_BACKFILL_DAYS) && v <= dayShift(today, 1);
}

async function addCheckin(uid, request, env, cors) {
  const reqBody = await readJson(request);
  if (!reqBody || typeof reqBody !== 'object') return res({ error: 'Invalid request body.' }, 400, cors);
  const { energy_level, time_of_day, tags, charged_by, drained_by, note, checkin_date } = reqBody;
  if (typeof energy_level !== 'number' || !isFinite(energy_level) || energy_level < 1 || energy_level > 10) {
    return res({ error: 'Energy level must be a number between 1 and 10' }, 400, cors);
  }
  if (!time_of_day || !['morning', 'afternoon', 'evening'].includes(time_of_day)) {
    return res({ error: 'Time of day must be morning, afternoon, or evening' }, 400, cors);
  }
  if (charged_by && (typeof charged_by !== 'string' || charged_by.length > 500)) return res({ error: 'charged_by too long' }, 400, cors);
  if (drained_by && (typeof drained_by !== 'string' || drained_by.length > 500)) return res({ error: 'drained_by too long' }, 400, cors);
  if (note && (typeof note !== 'string' || note.length > 2000)) return res({ error: 'note too long' }, 400, cors);
  if (tags && !validTags(tags)) {
    return res({ error: 'tags must be an array of known tags' }, 400, cors);
  }
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // Client sends checkin_date in the USER's timezone (tz modal promise:
  // check-ins reset at midnight in YOUR time), and may backdate a day they
  // missed. Absent or malformed falls back to UTC today, as before; present but
  // outside the window is a 400 rather than a silent rewrite to today, so a
  // client bug surfaces instead of filing the entry under the wrong day.
  let date = now.slice(0, 10);
  if (checkin_date !== undefined && checkin_date !== null && checkin_date !== '') {
    if (!validCheckinDate(checkin_date)) {
      return res({ error: `Check-in date must be today or within the last ${MAX_BACKFILL_DAYS} days` }, 400, cors);
    }
    date = checkin_date;
  }
  const tagsJson = Array.isArray(tags) ? JSON.stringify(tags) : (tags || null);
  await env.DB.prepare(
    'INSERT INTO checkins (id,user_id,energy_level,time_of_day,tags,charged_by,drained_by,note,checkin_date,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).bind(id, uid, energy_level, time_of_day, tagsJson, charged_by || null, drained_by || null, note || null, date, now).run();
  return res({ id, energy_level, time_of_day, tags: tagsJson, charged_by, drained_by, note, checkin_date: date, created_at: now }, 200, cors);
}

async function updateCheckin(uid, ciId, request, env, cors) {
  const existing = await env.DB.prepare('SELECT id FROM checkins WHERE id=? AND user_id=?').bind(ciId, uid).first();
  if (!existing) return res({ error: 'Not found' }, 404, cors);
  const body = await readJson(request);
  if (!body || typeof body !== 'object') return res({ error: 'Invalid request body.' }, 400, cors);
  if ('energy_level' in body) {
    const n = body.energy_level;
    if (typeof n !== 'number' || !isFinite(n) || n < 1 || n > 10) return res({ error: 'Invalid energy_level' }, 400, cors);
  }
  if ('time_of_day' in body && !['morning','afternoon','evening'].includes(body.time_of_day)) return res({ error: 'Invalid time_of_day' }, 400, cors);
  if ('charged_by' in body && body.charged_by && (typeof body.charged_by !== 'string' || body.charged_by.length > 500)) return res({ error: 'charged_by too long' }, 400, cors);
  if ('drained_by' in body && body.drained_by && (typeof body.drained_by !== 'string' || body.drained_by.length > 500)) return res({ error: 'drained_by too long' }, 400, cors);
  if ('note' in body && body.note && (typeof body.note !== 'string' || body.note.length > 2000)) return res({ error: 'note too long' }, 400, cors);
  if ('checkin_date' in body && !validCheckinDate(body.checkin_date)) return res({ error: 'Invalid checkin_date' }, 400, cors);
  const sets = [], vals = [];
  for (const field of ['energy_level', 'time_of_day', 'charged_by', 'drained_by', 'note', 'checkin_date']) {
    if (field in body) { sets.push(`${field}=?`); vals.push(body[field]); }
  }
  if ('tags' in body) {
    if (body.tags != null && !validTags(body.tags)) return res({ error: 'tags must be an array of known tags' }, 400, cors);
    sets.push('tags=?'); vals.push(body.tags ? JSON.stringify(body.tags) : null);
  }
  if (sets.length) await env.DB.prepare(`UPDATE checkins SET ${sets.join(',')} WHERE id=? AND user_id=?`).bind(...vals, ciId, uid).run();
  return res({ success: true }, 200, cors);
}

async function deleteCheckin(uid, ciId, env, cors) {
  const existing = await env.DB.prepare('SELECT id FROM checkins WHERE id=? AND user_id=?').bind(ciId, uid).first();
  if (!existing) return res({ error: 'Not found' }, 404, cors);
  await env.DB.prepare('DELETE FROM checkins WHERE id=? AND user_id=?').bind(ciId, uid).run();
  return res({ success: true }, 200, cors);
}

// ── Patterns endpoint ───────────────────────────────────────────────────────

// ── Recharge Menu ───────────────────────────────────────────────────────────
// Built entirely from check-ins the user already logged: no new questions, no
// AI. A tag earns a place on the menu when days carrying it averaged higher
// energy than the person's own baseline, often enough that it isn't noise. The
// free-text "what charged you" lines from their good days ride along as the
// description, in their own words, which is the part that makes it feel like
// theirs rather than a generic self-care list.
const MENU_HIGH_ENERGY = 7;   // what counts as a good day
const MENU_MIN_COUNT = 3;     // times a tag must appear before it's a pattern
const MENU_FULL_AT = 3;       // items below which the menu reads as still filling up
const MENU_SCAN_LIMIT = 1000; // most recent check-ins considered
// A menu is a short list of things worth choosing. Everything that merely beats
// the average by a rounding error makes it a report instead, so the bar is a
// visible lift and the list is capped.
const MENU_MIN_LIFT = 0.3;
const MENU_MAX_ITEMS = 5;

// Free text, so "Morning run" and "morning run  " are the same thing.
function normalizePhrase(s) { return String(s).trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!,;]+$/, ''); }

// Most frequent first, ties broken by the wording seen most recently.
function topPhrases(counter, limit) {
  return Object.entries(counter)
    .sort((a, b) => b[1].n - a[1].n || b[1].seen - a[1].seen)
    .slice(0, limit)
    .map(([, v]) => v.text);
}

// A dish description is read as being ABOUT that dish, so it may only use a
// phrase typed on a check-in tagged with this activity and nothing else. Anything
// looser produces "Sleep — morning run", or the same sentence under two different
// dishes, because a phrase shared a day with a tag rather than describing it.
// Unattributable phrases are not thrown away: they surface under "off menu",
// which claims nothing about any single activity.
function soloPhrases(counter, limit) {
  return Object.entries(counter)
    .filter(([, v]) => v.solo > 0)
    .sort((a, b) => b[1].solo - a[1].solo || b[1].n - a[1].n || b[1].seen - a[1].seen)
    .slice(0, limit)
    .map(([, v]) => v.text);
}

async function getRechargeMenu(uid, env, hubPro, cors) {
  if (!hasProAccess(hubPro)) {
    return res({
      error: 'Pro required',
      feature: 'recharge-menu',
      upgrade_url: upgradeUrl('recharge-menu'),
    }, 402, cors);
  }
  const rows = (await env.DB.prepare(
    'SELECT energy_level, tags, charged_by, time_of_day FROM checkins WHERE user_id=? ORDER BY checkin_date DESC, created_at DESC LIMIT ?'
  ).bind(uid, MENU_SCAN_LIMIT).all()).results || [];

  if (!rows.length) return res({ ready: false, items: [], in_your_words: [], total_checkins: 0, high_days: 0, avg_overall: 0 }, 200, cors);

  const avgOverall = rows.reduce((a, r) => a + r.energy_level, 0) / rows.length;

  // Null-prototype throughout: a stored tag called "__proto__" must not reach
  // Object.prototype. Same reasoning as getPatterns.
  const byTag = Object.create(null);
  const words = Object.create(null);
  let highDays = 0;
  let seen = rows.length;

  for (const r of rows) {
    seen--;
    const high = r.energy_level >= MENU_HIGH_ENERGY;
    if (high) highDays++;
    const phrase = typeof r.charged_by === 'string' && r.charged_by.trim() ? r.charged_by.trim().slice(0, 120) : null;
    if (high && phrase) {
      const key = normalizePhrase(phrase);
      if (key) {
        if (!words[key]) words[key] = { text: phrase, n: 0, seen };
        words[key].n++;
      }
    }
    let tags;
    try { tags = JSON.parse(r.tags); } catch { continue; }
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      if (typeof tag !== 'string') continue;
      if (!byTag[tag]) byTag[tag] = { sum: 0, count: 0, high: 0, times: Object.create(null), phrases: Object.create(null) };
      const t = byTag[tag];
      t.sum += r.energy_level;
      t.count++;
      if (high) {
        t.high++;
        if (r.time_of_day) t.times[r.time_of_day] = (t.times[r.time_of_day] || 0) + 1;
        if (phrase) {
          const key = normalizePhrase(phrase);
          if (key) {
            if (!t.phrases[key]) t.phrases[key] = { text: phrase, n: 0, seen, solo: 0 };
            t.phrases[key].n++;
            if (tags.length === 1) t.phrases[key].solo++;
          }
        }
      }
    }
  }

  const items = Object.entries(byTag)
    .map(([tag, t]) => ({
      tag,
      avg: t.sum / t.count,
      lift: t.sum / t.count - avgOverall,
      count: t.count,
      high_count: t.high,
      best_time: Object.entries(t.times).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      examples: soloPhrases(t.phrases, 3),
    }))
    .filter((i) => i.count >= MENU_MIN_COUNT && i.lift >= MENU_MIN_LIFT)
    .sort((a, b) => b.lift - a.lift)
    .slice(0, MENU_MAX_ITEMS);

  // Two dishes carrying the same sentence reads as a bug even when both earned
  // it honestly. Strongest lift keeps the phrase; the other drops to its next.
  const claimed = new Set();
  for (const i of items) {
    i.examples = i.examples.filter((e) => {
      const k = normalizePhrase(e);
      if (claimed.has(k)) return false;
      claimed.add(k);
      return true;
    });
  }

  return res({
    ready: items.length > 0,
    thin: items.length > 0 && items.length < MENU_FULL_AT,
    items,
    in_your_words: topPhrases(words, 5),
    avg_overall: avgOverall,
    total_checkins: rows.length,
    high_days: highDays,
    min_count: MENU_MIN_COUNT,
    high_energy: MENU_HIGH_ENERGY,
  }, 200, cors);
}

async function getPatterns(uid, env, hubPro, cors) {
  if (!hasProAccess(hubPro)) {
    return res({
      error: 'Pro required',
      feature: 'pattern-insights',
      upgrade_url: upgradeUrl('pattern-insights'),
    }, 402, cors);
  }
  // Average energy by time of day
  const byTime = await env.DB.prepare(
    'SELECT time_of_day, AVG(energy_level) as avg, COUNT(*) as count FROM checkins WHERE user_id=? GROUP BY time_of_day'
  ).bind(uid).all();

  // Average energy by day of week
  const byDow = await env.DB.prepare(
    "SELECT CAST(strftime('%w', checkin_date) AS INTEGER) as dow, AVG(energy_level) as avg, COUNT(*) as count FROM checkins WHERE user_id=? GROUP BY dow"
  ).bind(uid).all();

  // Weekly trend (last 12 weeks)
  const weekly = await env.DB.prepare(
    "SELECT strftime('%Y-W%W', checkin_date) as week, AVG(energy_level) as avg, COUNT(*) as count FROM checkins WHERE user_id=? GROUP BY week ORDER BY week DESC LIMIT 12"
  ).bind(uid).all();

  // Total stats
  const stats = await env.DB.prepare(
    'SELECT COUNT(*) as total, AVG(energy_level) as avg FROM checkins WHERE user_id=?'
  ).bind(uid).first();

  // Current streak
  const dates = await env.DB.prepare(
    'SELECT DISTINCT checkin_date FROM checkins WHERE user_id=? ORDER BY checkin_date DESC'
  ).bind(uid).all();
  const uniqueDates = (dates.results || []).map(d => d.checkin_date);
  const profileRow = await env.DB.prepare('SELECT timezone FROM users WHERE id=?').bind(uid).first();
  const streak = calcStreak(uniqueDates, todayInTz(profileRow?.timezone));
  const longestStreak = calcLongestStreak(uniqueDates);

  // All check-ins for tag analysis (client can also do this but server is more efficient)
  const allCheckins = await env.DB.prepare(
    'SELECT energy_level, tags FROM checkins WHERE user_id=? AND tags IS NOT NULL'
  ).bind(uid).all();

  // Compute tag averages
  // Null-prototype: a stored tag named "__proto__" or "constructor" must never
  // resolve to Object.prototype and poison every request in the isolate.
  const tagTotals = Object.create(null);
  for (const ci of (allCheckins.results || [])) {
    let tags;
    try { tags = JSON.parse(ci.tags); } catch { continue; }
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      if (!tagTotals[tag]) tagTotals[tag] = { sum: 0, count: 0 };
      tagTotals[tag].sum += ci.energy_level;
      tagTotals[tag].count++;
    }
  }
  const byTag = Object.entries(tagTotals).map(([tag, v]) => ({ tag, avg: v.sum / v.count, count: v.count }));

  return res({
    by_time: byTime.results || [],
    by_dow: byDow.results || [],
    weekly_trend: weekly.results || [],
    by_tag: byTag,
    total_checkins: stats?.total || 0,
    avg_overall: stats?.avg || 0,
    current_streak: streak,
    longest_streak: longestStreak,
  }, 200, cors);
}

// ── Recap stats endpoint ───────────────────────────────────
// Called by a connected Pro hub's weekly recap job with the shared RECAP_SERVICE_SECRET.
// The hub decides who is Pro; this endpoint only reports a user's week.

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

async function serviceRecap(url, request, env, cors) {
  const provided = request.headers.get('X-Internal-Secret') || '';
  if (!env.RECAP_SERVICE_SECRET || !timingSafeEqualStr(provided, env.RECAP_SERVICE_SECRET)) {
    return res({ error: 'Unauthorized' }, 401, cors);
  }
  const email = (url.searchParams.get('email') || '').trim().toLowerCase();
  const start = url.searchParams.get('start') || '';
  const end = url.searchParams.get('end') || '';
  if (!email || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return res({ error: 'email, start, end required' }, 400, cors);
  }
  const user = await env.DB.prepare('SELECT id, timezone FROM users WHERE email=?').bind(email).first();
  if (!user) return res({ found: false }, 200, cors);

  // Count + average energy over the window (inclusive).
  const agg = await env.DB.prepare(
    'SELECT COUNT(*) as n, AVG(energy_level) as avg, COUNT(DISTINCT checkin_date) as days FROM checkins WHERE user_id=? AND checkin_date BETWEEN ? AND ?'
  ).bind(user.id, start, end).first();
  const checkinCount = agg?.n || 0;
  const avgEnergy = checkinCount ? Math.round(agg.avg * 10) / 10 : 0;

  // Best weekday by average energy; needs at least 2 distinct days to mean anything.
  let bestDay = null;
  if ((agg?.days || 0) >= 2) {
    const top = await env.DB.prepare(
      "SELECT CAST(strftime('%w', checkin_date) AS INTEGER) as dow, AVG(energy_level) as avg FROM checkins WHERE user_id=? AND checkin_date BETWEEN ? AND ? GROUP BY dow ORDER BY avg DESC LIMIT 1"
    ).bind(user.id, start, end).first();
    if (top && top.dow >= 0 && top.dow <= 6) bestDay = WEEKDAY_NAMES[top.dow];
  }

  // Tag averages over the window — same aggregation as /api/patterns, but
  // scoped to the recap week and requiring 2+ occurrences per tag.
  const tagged = await env.DB.prepare(
    'SELECT energy_level, tags FROM checkins WHERE user_id=? AND checkin_date BETWEEN ? AND ? AND tags IS NOT NULL'
  ).bind(user.id, start, end).all();
  // Null-prototype: a stored tag named "__proto__" or "constructor" must never
  // resolve to Object.prototype and poison every request in the isolate.
  const tagTotals = Object.create(null);
  for (const ci of (tagged.results || [])) {
    let tags;
    try { tags = JSON.parse(ci.tags); } catch { continue; }
    if (!Array.isArray(tags)) continue;
    for (const tag of tags) {
      if (!tagTotals[tag]) tagTotals[tag] = { sum: 0, count: 0 };
      tagTotals[tag].sum += ci.energy_level;
      tagTotals[tag].count++;
    }
  }
  const qualifying = Object.entries(tagTotals)
    .filter(([, v]) => v.count >= 2)
    .map(([tag, v]) => ({ tag, avg: v.sum / v.count }))
    .sort((a, b) => b.avg - a.avg);
  const topCharger = qualifying.length ? qualifying[0].tag : null;
  // With a single qualifying tag it would be charger AND drainer; call it a
  // charger and leave drainer null rather than send a contradictory email.
  const topDrainer = qualifying.length >= 2 ? qualifying[qualifying.length - 1].tag : null;

  // Current streak — exact same computation as /api/checkins: all check-in
  // dates (not just the window), "today" in the user's own timezone.
  const dates = await env.DB.prepare(
    'SELECT DISTINCT checkin_date FROM checkins WHERE user_id=? ORDER BY checkin_date DESC'
  ).bind(user.id).all();
  const currentStreak = calcStreak((dates.results || []).map(d => d.checkin_date), todayInTz(user.timezone));

  return res({
    found: true,
    stats: {
      checkin_count: checkinCount,
      avg_energy: avgEnergy,
      best_day: bestDay,
      top_charger: topCharger,
      top_drainer: topDrainer,
      current_streak: currentStreak,
      skip: checkinCount === 0,
    },
  }, 200, cors);
}

// "Today" (YYYY-MM-DD) in the given IANA timezone; falls back to UTC.
function todayInTz(tz) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

// Streak math with the backup cell: one missed day is covered
// as long as no other covered day falls within the 7 days before it. Two missed days in a
// row still end the streak. The streak counts logged days only.
function ebShiftDay(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function ebDaysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function calcStreakInfo(sortedDatesDesc, today) {
  today = today || new Date().toISOString().slice(0, 10);
  const logged = new Set(sortedDatesDesc);
  // A streak may run through yesterday: today is still in progress.
  let day = logged.has(today) ? today : ebShiftDay(today, -1);
  let streak = 0;
  const covered = []; // newest first
  for (let guard = 0; guard < 4000; guard++) {
    if (logged.has(day)) { streak++; day = ebShiftDay(day, -1); continue; }
    const prev = ebShiftDay(day, -1);
    const last = covered[covered.length - 1];
    if (logged.has(prev) && (!last || ebDaysBetween(day, last) >= 7)) { covered.push(day); day = prev; continue; }
    break;
  }
  if (!streak) return { streak: 0, used_on: null, ready: true, recharges_on: null };
  const recent = covered[0] || null;
  // The next day that could be missed: today if it isn't logged yet, otherwise tomorrow.
  const nextMiss = logged.has(today) ? ebShiftDay(today, 1) : today;
  const ready = !recent || ebDaysBetween(recent, nextMiss) >= 7;
  return { streak, used_on: ready ? null : recent, ready, recharges_on: ready ? null : ebShiftDay(recent, 7) };
}
function calcStreak(sortedDatesDesc, today) {
  return calcStreakInfo(sortedDatesDesc, today).streak;
}
function calcLongestStreak(sortedDatesDesc) {
  if (!sortedDatesDesc.length) return 0;
  const asc = [...new Set(sortedDatesDesc)].sort();
  let longest = 1, current = 1, lastCovered = null;
  for (let i = 1; i < asc.length; i++) {
    const gap = ebDaysBetween(asc[i - 1], asc[i]);
    const miss = ebShiftDay(asc[i - 1], 1);
    if (gap === 1) current++;
    else if (gap === 2 && (!lastCovered || ebDaysBetween(lastCovered, miss) >= 7)) { current++; lastCovered = miss; }
    else { current = 1; lastCovered = null; }
    longest = Math.max(longest, current);
  }
  return longest;
}
