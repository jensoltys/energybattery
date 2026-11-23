-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Energy Battery authors. See LICENSE.
-- 0003_email_daily.sql: global daily email ceiling
--
-- One row per (bucket, UTC day). The Worker bumps it with an atomic
--   INSERT ... ON CONFLICT(k, day) DO UPDATE SET n = n + 1 RETURNING n
-- before sending a verification code or a reset link, and refuses once n passes
-- the bucket's daily cap (MAIL_DAILY in src/worker.js). Buckets: 'verify-mail'
-- (signup + resend) and 'reset-mail', kept apart so signup spam can't use up
-- the password resets. Rows older than today are deleted by the daily purge.

CREATE TABLE IF NOT EXISTS email_daily (
  k TEXT NOT NULL,
  day TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (k, day)
);
