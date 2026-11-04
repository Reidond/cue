-- The settings that are the person's, not a device's (Settings › General; `Me.settings`, `PATCH /v1/me/settings`), beside their languages. Null: the
-- account has none yet; the first app to sign in sends its own, and until then calls and notes go by what their requests say.
ALTER TABLE preference ADD COLUMN speaker_name TEXT;
ALTER TABLE preference ADD COLUMN auto_answer INTEGER;
ALTER TABLE preference ADD COLUMN mic_questions INTEGER;
ALTER TABLE preference ADD COLUMN summarize INTEGER;
ALTER TABLE preference ADD COLUMN keep_audio INTEGER;
