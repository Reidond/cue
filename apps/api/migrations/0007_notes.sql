-- After a call: the recording's audio (multipart uploads to R2, parts tracked here because the R2 binding cannot list them) and the notes the Workflow makes.
-- Times are milliseconds since the epoch; the transcript's are seconds since the recording began.
CREATE TABLE upload (
	upload_id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	call_id TEXT NOT NULL,
	-- The recording's start: a call can hold several recordings.
	take INTEGER NOT NULL,
	side TEXT NOT NULL,
	object_key TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'open',
	size INTEGER,
	created_at INTEGER NOT NULL,
	UNIQUE (call_id, take, side)
);
CREATE TABLE upload_part (
	upload_id TEXT NOT NULL REFERENCES upload (upload_id) ON DELETE CASCADE,
	part_number INTEGER NOT NULL,
	etag TEXT NOT NULL,
	size INTEGER NOT NULL,
	PRIMARY KEY (upload_id, part_number)
);

CREATE TABLE note (
	id TEXT PRIMARY KEY NOT NULL,
	user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	call_id TEXT REFERENCES call (id) ON DELETE SET NULL,
	project_id TEXT REFERENCES project (id) ON DELETE SET NULL,
	take INTEGER,
	-- The identity of a note imported from a Mac's library (ISO 8601 start of the call).
	stamp TEXT,
	title TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	duration_seconds REAL NOT NULL DEFAULT 0,
	status TEXT NOT NULL DEFAULT 'processing',
	language TEXT NOT NULL DEFAULT 'en',
	-- What was spoken when that isn't the project's language (the Deepgram language of the recording).
	spoken_language TEXT,
	speaker TEXT NOT NULL DEFAULT '',
	-- JSON {title, attendees}, or null.
	meeting TEXT,
	-- JSON: the user first, then the labels or names of the others.
	participants TEXT NOT NULL DEFAULT '[]',
	summary TEXT NOT NULL DEFAULT '',
	transcript_heading TEXT NOT NULL DEFAULT 'Transcript',
	-- JSON turns [{channel, speaker, label, start, text}]: what the note shows.
	transcript TEXT NOT NULL DEFAULT '[]',
	-- JSON lines [{channel, speaker, text, start, end}] the turns are made of (the live transcript until the second pass replaces it).
	lines TEXT NOT NULL DEFAULT '[]',
	-- JSON [{voice, start, end}]: who spoke when on the call side, from the recorded file's diarization.
	voices TEXT,
	-- JSON {label: name}.
	suggestions TEXT NOT NULL DEFAULT '{}',
	-- JSON [{id, title, state, detail}].
	steps TEXT NOT NULL DEFAULT '[]',
	-- JSON {me, others, mixed}: the R2 keys of the audio still in storage.
	audio TEXT NOT NULL DEFAULT '{}',
	keep_audio INTEGER NOT NULL DEFAULT 1,
	summarize INTEGER NOT NULL DEFAULT 1,
	ready_at INTEGER,
	audio_deleted_at INTEGER,
	trashed_at INTEGER,
	created_at INTEGER NOT NULL,
	UNIQUE (call_id, take),
	UNIQUE (user_id, stamp)
);
CREATE INDEX note_user_idx ON note (user_id, started_at);
CREATE INDEX note_project_idx ON note (project_id, started_at);
-- The janitor looks for audio past its retention.
CREATE INDEX note_audio_idx ON note (ready_at) WHERE audio_deleted_at IS NULL AND ready_at IS NOT NULL;

-- What the Workflow did, in order: the progress the client follows (server-sent events) and the session log's lines.
CREATE TABLE note_event (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	note_id TEXT NOT NULL REFERENCES note (id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	step TEXT,
	state TEXT NOT NULL,
	line TEXT,
	detail TEXT,
	at INTEGER NOT NULL
);
CREATE INDEX note_event_idx ON note_event (note_id, seq);
