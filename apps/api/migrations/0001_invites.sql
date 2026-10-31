-- The invite-only allowlist. A first sign-in is accepted only for an email on this list (or one of ADMIN_EMAILS).
-- `disabled` ends an invite without forgetting it: the owner script sets it with the user's `banned` flag.
CREATE TABLE invite (
	email TEXT PRIMARY KEY NOT NULL,
	disabled INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
