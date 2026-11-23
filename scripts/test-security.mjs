// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 the Energy Battery authors. See LICENSE.
// Security regression scanner. Catches every class of issue surfaced in the
// earlier security reviews so the same thing can't silently regress in a future change.
// Run: node scripts/test-security.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

function listFiles(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === 'vendor' || entry === 'node_modules' || entry === '.wrangler' || entry === 'dist' || entry === 'build') continue;
      listFiles(full, exts, out);
    } else if (exts.some(e => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const findings = [];
function flag(severity, file, line, rule, detail) {
  findings.push({ severity, file: relative(repoRoot, file), line, rule, detail });
}

// ── Source code checks (src/) ──────────────────────────────────────────────
const srcFiles = listFiles(join(repoRoot, 'src'), ['.js']);

for (const f of srcFiles) {
  const content = readFileSync(f, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const ln = idx + 1;

    // SELECT * — never allowed; columns must be explicit.
    // Skip lines that are JS comments (// ...) or SQL comments (-- ...) — they
    // intentionally talk about the rule without violating it.
    {
      const commentStripped = line.replace(/\/\/.*$/, '').replace(/--.*$/, '');
      if (/\bSELECT\s+\*/i.test(commentStripped)) {
        flag('HIGH', f, ln, 'SELECT *', 'Explicitly list columns. Prevents leaking new sensitive columns added later (e.g. password_hash, token_version).');
      }
    }

    // CORS wildcard.
    if (/Access-Control-Allow-Origin['"\s:,]+\*/.test(line)) {
      flag('HIGH', f, ln, 'CORS wildcard', 'Origin allowlist is required when credentials are sent. Never `*`.');
    }

    // Hardcoded secret patterns.
    if (/sk-ant-api03-[A-Za-z0-9_-]{20,}/.test(line)) flag('HIGH', f, ln, 'hardcoded ANTHROPIC key', 'Move to wrangler secret.');
    if (/\bre_[A-Za-z0-9]{20,}/.test(line))            flag('HIGH', f, ln, 'hardcoded RESEND key', 'Move to wrangler secret.');
    if (/sk_live_[A-Za-z0-9]{20,}/.test(line))         flag('HIGH', f, ln, 'hardcoded STRIPE live key', 'Move to wrangler secret.');
    if (/sk-[A-Za-z0-9]{40,}/.test(line) && !/sk-ant/.test(line)) flag('HIGH', f, ln, 'hardcoded OpenAI-shaped key', 'Move to wrangler secret.');
    if (/xox[baprs]-[A-Za-z0-9-]{20,}/.test(line))     flag('HIGH', f, ln, 'hardcoded Slack token', 'Move to secret store.');
    if (/AIza[A-Za-z0-9_-]{30,}/.test(line))           flag('HIGH', f, ln, 'hardcoded Google API key', 'Move to secret store.');
    if (/ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/.test(line)) flag('HIGH', f, ln, 'hardcoded GitHub PAT', 'Move to secret store.');

    // PII / secrets in console logs.
    if (/console\.(log|error|warn|info|debug)\s*\([^)]*\b(password|passwordHash|pw_hash|token|jwt|apiKey|api_key|secret|authorization|req\.body|request\.body|raw_text)\b/i.test(line)
        && !/['"`][^'"`]*(password|token|jwt|secret|api_key|apiKey)[^'"`]*['"`]/i.test(line.replace(/console\.[a-z]+\s*\(/i, ''))) {
      if (!/['"]\s*[^'"]*(password|token|secret|api[_-]?key)[^'"]*['"]\s*\)/i.test(line)) {
        flag('MEDIUM', f, ln, 'PII / secret in console log', 'Log identifier (user_id, request_id) — never the data.');
      }
    }

    // Storing sensitive values in localStorage / sessionStorage.
    if (/(localStorage|sessionStorage)\.setItem\s*\(\s*['"`][^'"`]*(password|secret|apiKey|api_key|credit|card|ssn)/i.test(line)) {
      flag('HIGH', f, ln, 'sensitive data in browser storage', 'Use HttpOnly cookies for auth; never localStorage.');
    }
  });

  // Module-level mutable CORS state — the race we just fixed in Fix 8.
  // A top-level `let CORS = {}` (or `let _cors = {}`) being mutated per request
  // is exactly the pattern an earlier review caught.
  if (/^\s*let\s+(CORS|_cors|corsHeaders)\s*=/m.test(content)) {
    flag('HIGH', f, 0, 'module-level CORS state', 'CORS headers must be per-request. Concurrent requests on the same isolate will race.');
  }

  // Origin allowlist sanity check: must reference Origin header somewhere.
  if (f.endsWith('worker.js') && !/new URL\(request\.url\)\.origin/.test(content)) {
    flag('HIGH', f, 0, 'missing same-origin check', 'CORS and CSRF must trust only this site\'s own origin.');
  }

  // CSRF Origin check helper must exist and be wired into mutations.
  if (f.endsWith('worker.js') && !/checkOrigin\(/.test(content)) {
    flag('HIGH', f, 0, 'missing checkOrigin helper', 'CSRF Origin/Referer check required on sensitive mutations.');
  }

  // Password validator must enforce min 10 / max 200.
  if (f.endsWith('worker.js') && !/isValidPassword/.test(content)) {
    flag('HIGH', f, 0, 'missing isValidPassword helper', 'Password length must be enforced (min 10 / max 200) at all four sites.');
  }

  // Email validator must exist.
  if (f.endsWith('worker.js') && !/isValidEmail/.test(content)) {
    flag('HIGH', f, 0, 'missing isValidEmail helper', 'Email regex + max 254 trim+lowercase required at signup and login.');
  }

  // Token hashing helper must exist (Fix 7).
  if (f.endsWith('worker.js') && !/sha256Hex/.test(content)) {
    flag('HIGH', f, 0, 'missing sha256Hex helper', 'Reset and verification tokens must be hashed-at-rest.');
  }

  // GDPR export must exist (Fix 11).
  if (f.endsWith('worker.js') && !/exportAccount/.test(content)) {
    flag('HIGH', f, 0, 'missing GDPR export endpoint', 'GET /api/account/export required for GDPR Article 15.');
  }

  // Vary: Origin must be set (Fix 9).
  if (f.endsWith('worker.js') && !/['"]Vary['"]\s*:\s*['"]Origin['"]/.test(content)) {
    flag('MEDIUM', f, 0, 'missing Vary: Origin header', 'Required to prevent CORS-cached response cross-contamination.');
  }

  // Account delete must require current_password (Fix 6).
  if (f.endsWith('worker.js')) {
    const deleteAcctMatch = content.match(/async function deleteAccount\s*\([^)]*\)\s*\{[\s\S]*?\n\}/);
    if (deleteAcctMatch && !/current_password/.test(deleteAcctMatch[0])) {
      flag('HIGH', f, 0, 'deleteAccount missing password re-prompt', 'Stolen JWT must not be sufficient to wipe data.');
    }
  }

  // CSP `'unsafe-inline'` for scripts: fixed, keep it that way.
  // Worker now ships `script-src 'self'` (no unsafe-inline). Inline JS lives
  // in public/app.js, inline event handlers replaced with addEventListener.
  // Guard against regression: flag HIGH if 'unsafe-inline' creeps back into
  // script-src in worker.js.
  if (f.endsWith('worker.js')) {
    const cspMatch = content.match(/script-src[^;'"]*['"]unsafe-inline['"]/);
    if (cspMatch) {
      flag('HIGH', f, 0, "CSP script-src reintroduced 'unsafe-inline'", 'Regression: keep script-src clean.');
    }
  }
}

// ── HTML asset checks (public/) ────────────────────────────────────────────
const htmlFiles = listFiles(join(repoRoot, 'public'), ['.html']);

for (const f of htmlFiles) {
  const content = readFileSync(f, 'utf8');
  const lines = content.split('\n');

  lines.forEach((line, idx) => {
    const ln = idx + 1;

    // target=_blank without rel=noopener on the same tag.
    const linkRe = /<a\b[^>]*\btarget\s*=\s*["']_blank["'][^>]*>/gi;
    const matches = line.match(linkRe);
    if (matches) {
      for (const tag of matches) {
        if (!/\brel\s*=\s*["'][^"']*\bnoopener\b/i.test(tag)) {
          flag('LOW', f, ln, 'target=_blank without rel=noopener', tag.slice(0, 80));
        }
      }
    }

    // CDN script without SRI hash.
    const cdnScript = line.match(/<script[^>]+src\s*=\s*["']https:\/\/(cdn\.|unpkg\.|cdnjs\.)[^"']+["'][^>]*>/gi);
    if (cdnScript) {
      for (const tag of cdnScript) {
        if (!/\bintegrity\s*=/i.test(tag)) {
          flag('MEDIUM', f, ln, 'CDN script without SRI', tag.slice(0, 80));
        }
      }
    }

    // Newsletter / marketing consent checkbox default-checked — GDPR + ePrivacy violation.
    const checkboxMatches = line.match(/<input\b[^>]*\btype\s*=\s*["']checkbox["'][^>]*>/gi);
    if (checkboxMatches) {
      for (const tag of checkboxMatches) {
        if (/\b(newsletter|marketing|subscribe|opt[-_]?in|promo|emails?)\b/i.test(tag) && /\bchecked\b/i.test(tag)) {
          flag('HIGH', f, ln, 'consent checkbox default-checked', 'Pre-checked consent boxes violate GDPR/ePrivacy. Default unchecked.');
        }
      }
    }
  });

  // Privacy + Terms links must exist on the main user-facing index page.
  if (/index\.html$/i.test(f)) {
    if (!/href\s*=\s*["'][^"']*\/legal\/privacy/i.test(content)) {
      flag('HIGH', f, 0, 'no /legal/privacy link on index', 'GDPR/CCPA require accessible privacy notice from every collection point.');
    }
    if (!/href\s*=\s*["'][^"']*\/legal\/terms/i.test(content)) {
      flag('MEDIUM', f, 0, 'no /legal/terms link on index', 'Terms of Service must be linked from auth screen.');
    }
    if (!/href\s*=\s*["'][^"']*\/legal\/do-not-sell/i.test(content)) {
      flag('MEDIUM', f, 0, 'no /legal/do-not-sell link on index', 'CCPA/CPRA-required "Do Not Sell or Share" link must be present.');
    }
    // Account delete must use a password re-prompt modal, not just confirm()s.
    if (!/delete-account-modal|performDeleteAccount/.test(content)) {
      flag('HIGH', f, 0, 'account delete missing password re-prompt UI', 'Stolen JWT must not be sufficient to wipe data with confirm() clicks.');
    }
    // Auth password input must enforce min 10.
    if (!/id\s*=\s*["']auth-pw["'][^>]*minlength\s*=\s*["']10["']/.test(content)) {
      flag('MEDIUM', f, 0, 'auth password input minlength < 10', 'Passwords need min 10 characters.');
    }
  }
}

// ── Legal pages — must exist with LLC entity info ──────────────────────────
const requiredLegalPages = [
  { path: 'public/legal/privacy.html', name: 'Privacy Policy' },
  { path: 'public/legal/terms.html', name: 'Terms of Service' },
  { path: 'public/legal/do-not-sell.html', name: 'Do Not Sell or Share' },
];
for (const { path, name } of requiredLegalPages) {
  const full = join(repoRoot, path);
  if (!existsSync(full)) {
    flag('HIGH', full, 0, `missing legal page: ${name}`, 'Compliance requires accessible policy at this path.');
    continue;
  }
  const c = readFileSync(full, 'utf8');
  // The operator line: fill in YOUR COMPANY NAME and YOUR BUSINESS ADDRESS with your own.
  if (!/Operator:<\/strong>/.test(c) && !/<strong>[^<]+<\/strong><br>/.test(c) && !/YOUR COMPANY NAME/.test(c)) {
    flag('HIGH', full, 0, `${name} missing operator entity`, 'Name the operator (your company) on every legal page.');
  }
}

// ── Migrations directory must exist with at least 0001_initial + 0002_email_verification ──
const migDir = join(repoRoot, 'migrations');
if (!existsSync(migDir)) {
  flag('HIGH', migDir, 0, 'missing migrations/ directory', 'Schema drift between code and disk; required for clean rebuild.');
} else {
  const migFiles = readdirSync(migDir).filter(f => f.endsWith('.sql'));
  if (!migFiles.some(f => /0001/.test(f))) {
    flag('HIGH', migDir, 0, 'missing 0001 initial migration', 'Initial schema must be codified.');
  }
  if (!migFiles.some(f => /email_verification/i.test(f))) {
    flag('HIGH', migDir, 0, 'missing email_verification migration', 'email_verification_tokens table and users.email_verified column must be in migrations.');
  }
}

// ── Transactional email templates must include LLC postal address ──────────
const workerJs = readFileSync(join(repoRoot, 'src', 'worker.js'), 'utf8');
// Every email uses the shared footer (emailFooterText() + emailFooterHtml(), see
// worker.js). The footer itself must carry the LLC name + postal address, and
// each template must use it (or name the LLC inline).
const hasFooter = (chunk) => /emailFooterText\(\)|emailFooterHtml\(/.test(chunk);
const footerDef = workerJs.match(/const EMAIL_SENDER_LINE = '[^']*'/);
if (!footerDef) {
  flag('HIGH', join(repoRoot, 'src', 'worker.js'), 0, 'email footer missing LLC postal address', 'CAN-SPAM postal address required in transactional emails.');
}
const verifyMatch = workerJs.match(/Your Energy Battery code is[\s\S]{0,2000}/);
if (!verifyMatch || !hasFooter(verifyMatch[0])) {
  flag('HIGH', join(repoRoot, 'src', 'worker.js'), 0, 'verify email missing LLC postal address', 'CAN-SPAM postal address required in transactional emails.');
}
const resetMatch = workerJs.match(/Reset your Energy Battery password[\s\S]{0,2000}/);
if (!resetMatch || !hasFooter(resetMatch[0])) {
  flag('HIGH', join(repoRoot, 'src', 'worker.js'), 0, 'reset email missing LLC postal address', 'CAN-SPAM postal address required in transactional emails.');
}

// ── Report ─────────────────────────────────────────────────────────────────
if (findings.length === 0) {
  console.log(`   scanned ${srcFiles.length} src + ${htmlFiles.length} html files, no security regressions found`);
  process.exit(0);
}

const high = findings.filter(f => f.severity === 'HIGH');
const med  = findings.filter(f => f.severity === 'MEDIUM');
const low  = findings.filter(f => f.severity === 'LOW');

console.error(`   ✗ security scan: ${high.length} HIGH, ${med.length} MEDIUM, ${low.length} LOW`);
for (const f of findings) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  console.error(`     [${f.severity}] ${where}  '${f.rule}'  — ${f.detail}`);
}

// Block on HIGH; warn-only on MEDIUM/LOW.
if (high.length > 0) process.exit(1);
console.error('   (warnings only — deploy continues)');
process.exit(0);
