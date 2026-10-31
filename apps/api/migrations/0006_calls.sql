-- A live call: one stretch of listening (the Call Durable Object holds it while it runs). The final transcript lines are kept when it ends,
-- as JSON [{channel, speaker, text, start, end}] (seconds since the call began); PR 6's notes start from them. Times are milliseconds since the epoch.
CREATE TABLE call (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	project_id TEXT REFERENCES project (id) ON DELETE SET NULL,
	-- The calendar event the call is for, if any.
	event_id TEXT,
	event_title TEXT,
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	transcript TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX call_user_idx ON call (user_id, started_at);
