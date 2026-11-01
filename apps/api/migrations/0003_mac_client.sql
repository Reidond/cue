-- Cue for Mac: a first-party public client (no secret), PKCE required, consent skipped.
INSERT INTO "oauthClient" (
	"id", "clientId", "name", "redirectUris", "tokenEndpointAuthMethod", "applicationType",
	"grantTypes", "responseTypes", "scopes", "requirePKCE", "skipConsent", "disabled", "createdAt", "updatedAt"
) VALUES (
	'cue-mac', 'cue-mac', 'Cue for Mac', '["com.andriishafar.cue:/oauth/callback"]', 'none', 'native',
	'["authorization_code","refresh_token"]', '["code"]', '["openid","profile","email","offline_access"]',
	1, 1, 0, unixepoch() * 1000, unixepoch() * 1000
);

-- The API the app asks tokens for (RFC 8707 `resource`; it becomes the JWT `aud`), and the link that lets it.
INSERT INTO "oauthResource" ("id", "identifier", "name", "createdAt", "updatedAt")
VALUES ('cue-api', 'https://api.cue.test', 'Cue API', unixepoch() * 1000, unixepoch() * 1000);

INSERT INTO "oauthClientResource" ("id", "clientId", "resourceId", "createdAt")
VALUES ('cue-mac-cue-api', 'cue-mac', 'https://api.cue.test', unixepoch() * 1000);
