-- A person's projects (one talk or series of calls) and the files they added to them. Each user sees only their own: every query
-- carries the user id. Times are milliseconds since the epoch (as the API speaks them).
CREATE TABLE project (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	name TEXT NOT NULL,
	-- A sentence or two about the talk and who will be asking.
	occasion TEXT NOT NULL DEFAULT '',
	-- The spoken language, as a code: 'en', 'uk', ...
	language TEXT NOT NULL DEFAULT 'en',
	-- Names and terms as typed (one per line, or separated by commas or semicolons); `terms` in the API is this, split.
	names_and_terms TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);
CREATE INDEX project_user_idx ON project (user_id, created_at);

-- A file in a project. The original is in R2 (`r2_key`); `text` is what the server read from it, `qa` the places in it to look for prepared
-- answers when that isn't the whole text (a slide deck: its speaker notes, slide by slide). Prepared answers are found when asked for,
-- in the project's language, so changing the language changes them.
CREATE TABLE material (
	id TEXT PRIMARY KEY NOT NULL,
	project_id TEXT NOT NULL REFERENCES project (id) ON DELETE CASCADE,
	user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	name TEXT NOT NULL,
	content_type TEXT NOT NULL,
	size INTEGER NOT NULL,
	-- The upload's ETag: the same name with the same ETag is the same file.
	etag TEXT NOT NULL,
	r2_key TEXT NOT NULL,
	-- Null when the text could be read; otherwise why not.
	error TEXT,
	text TEXT NOT NULL DEFAULT '',
	-- JSON: [{source, lines}], or null to look in all of `text`, as `name`.
	qa TEXT,
	words INTEGER NOT NULL DEFAULT 0,
	-- A slide deck's slide count.
	slides INTEGER,
	created_at INTEGER NOT NULL
);
CREATE INDEX material_project_idx ON material (project_id, created_at);
