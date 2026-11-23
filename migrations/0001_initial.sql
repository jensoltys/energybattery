-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Energy Battery authors. See LICENSE.
-- 0001_initial.sql — Energy Battery base schema
-- This mirrors the original schema.sql as the historical starting point.
-- Subsequent ALTERs and new tables live in later migrations.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  newsletter_consent INTEGER DEFAULT 0,
  newsletter_consent_at TEXT,
  timezone TEXT DEFAULT 'America/New_York',
  token_version INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reset_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0
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

CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_id);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(user_id, checkin_date);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_user ON reset_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_rate_limits_key ON rate_limits(key, created_at);
