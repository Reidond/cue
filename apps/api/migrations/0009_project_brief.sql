-- What Cue writes from a project's materials (src/materials/brief.ts): the occasion, the names and terms speech recognition should listen for,
-- and the questions people are likely to ask with their answers. The person's own `occasion` and `names_and_terms` replace the brief's when they
-- are not empty. Every file added or removed counts in `materials_version`; the brief was made from `brief_version`, and the Workflow that makes it
-- only writes it when no file changed meanwhile.
ALTER TABLE project ADD COLUMN brief_state TEXT NOT NULL DEFAULT 'none';
ALTER TABLE project ADD COLUMN brief_error TEXT;
ALTER TABLE project ADD COLUMN brief_occasion TEXT NOT NULL DEFAULT '';
-- One per line.
ALTER TABLE project ADD COLUMN brief_terms TEXT NOT NULL DEFAULT '';
-- JSON: [{q, a, who, source, materialId}].
ALTER TABLE project ADD COLUMN brief_answers TEXT NOT NULL DEFAULT '[]';
ALTER TABLE project ADD COLUMN brief_updated_at INTEGER;
ALTER TABLE project ADD COLUMN materials_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project ADD COLUMN brief_version INTEGER NOT NULL DEFAULT 0;

-- The spoken language is heard, never chosen: `project.language` is now the one Cue last heard in the project's calls (Deepgram's multilingual
-- model says what each word is in), and a call keeps the one it was held in for its notes.
ALTER TABLE call ADD COLUMN language TEXT;
