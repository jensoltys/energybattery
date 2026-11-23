-- SPDX-License-Identifier: AGPL-3.0-only
-- Copyright (C) 2026 the Energy Battery authors. See LICENSE.
-- 0004_track_focus.sql: onboarding "What do you want to track?" (UX fixes, 2026-11)
--
-- JSON array drawn from work, sleep, food, people (validated in the Worker by
-- validTrackFocus). The client floats the matching tag pills to the front of
-- the check-in form. NULL = never answered, which is every account created
-- before this shipped.
--
-- MUST be applied to the remote D1 BEFORE the Worker that reads it deploys:
-- getProfile() selects this column, so /api/profile 500s without it.
--   npx wrangler d1 execute energy-battery --remote --file migrations/0004_track_focus.sql

ALTER TABLE users ADD COLUMN track_focus TEXT;
