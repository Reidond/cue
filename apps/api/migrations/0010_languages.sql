-- The languages a person reads Cue in (Settings › General › Languages), in order, as JSON: [] or ["en"] or ["en", "uk"]. With two, every answer
-- comes in both (the language the call is held in, each line followed by its translation) and every note gets a translation (`note.translation`).
CREATE TABLE preference (
	user_id TEXT PRIMARY KEY NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
	languages TEXT NOT NULL DEFAULT '[]',
	updated_at INTEGER NOT NULL
);

-- JSON: {language, name, title, summary, transcript: [one per turn]}, or null.
ALTER TABLE note ADD COLUMN translation TEXT;
