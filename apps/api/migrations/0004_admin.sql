-- What the backend spent on each person: one row per priced call. The admin reads it (overview, users); PR 7 writes it, and
-- enforces the limit against it. Money is millionths of a US dollar so sums never drift.
CREATE TABLE usage (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	-- What the person was doing: 'answer', 'question_judge', 'live_transcript', 'notes_transcript', 'notes_summary', ...
	feature TEXT NOT NULL,
	-- Who was paid: 'anthropic', 'deepgram'.
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	-- How much of it: a count of `unit` ('input_tokens', 'output_tokens', 'cache_read_tokens', 'audio_seconds', ...).
	units REAL NOT NULL,
	unit TEXT NOT NULL,
	cost_micros INTEGER NOT NULL,
	created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX usage_created_at_idx ON usage (created_at);
CREATE INDEX usage_user_created_at_idx ON usage (user_id, created_at);

-- A monthly limit set for one person; without a row the default (the `default_monthly_limit_usd` setting) applies.
CREATE TABLE user_limit (
	user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	monthly_usd REAL NOT NULL
);

-- The owner's settings: `default_monthly_limit_usd`, `audio_retention_days`, `plan_paused` ('1' while the whole plan is paused).
-- A key without a row has its default (src/settings.ts).
CREATE TABLE setting (
	key TEXT PRIMARY KEY NOT NULL,
	value TEXT NOT NULL
);
