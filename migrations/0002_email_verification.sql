-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Energy Battery authors. See LICENSE.
-- 0002_email_verification.sql: email verification columns and token table.
--
-- Note: tokens are now stored SHA-256 hashed (the column is still TEXT but
-- holds the hex digest, not the raw token). The user sees the unhashed token
-- in their email; lookups hash-and-compare server-side.

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN verified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_email_verification_user ON email_verification_tokens(user_id);
