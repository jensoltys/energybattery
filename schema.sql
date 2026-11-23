-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Energy Battery authors. See LICENSE.
-- Energy Battery — D1 Schema (canonical post-migration target)
-- For incremental upgrades, use migrations/ in order. This file is the
-- "what the DB should look like after all migrations are applied" reference,
-- safe to run on an empty database for a clean rebuild.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  newsletter_consent INTEGER DEFAULT 0,
  newsletter_consent_at TEXT,
  timezone TEXT DEFAULT 'America/New_York',
  track_focus TEXT,
  token_version INTEGER DEFAULT 0,
  email_verified INTEGER DEFAULT 0,
  verified_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reset_tokens (
  -- Stored SHA-256 hex digest of the raw token. The user sees the raw token
  -- only in their email; the DB never holds it in a replayable form.
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  -- Stored SHA-256 hex digest of the raw token, same pattern as reset_tokens.
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checkins (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  energy_level INTEGER NOT NULL CHECK(energy_level BETWEEN 1 AND 10),
  time_of_day TEXT NOT NULL,
  tags TEXT,
  charged_by TEXT,
  drained_by TEXT,
  note TEXT,
  checkin_date TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Global daily email ceiling (migrations/0003_email_daily.sql).
CREATE TABLE IF NOT EXISTS email_daily (
  k TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, day)
);

CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_id);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(user_id, checkin_date);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_user ON reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key ON rate_limits(key, created_at);
