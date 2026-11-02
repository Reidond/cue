-- Cue for Windows: a first-party public client (no secret), PKCE required, consent skipped, like Cue for Mac. It signs in through the system
-- browser and a loopback redirect (RFC 8252 §7.3): the redirect is registered without a port, and the authorization server accepts any
-- port on 127.0.0.1 for it, since the app takes the one the system gives it.
INSERT INTO "oauthClient" (
	"id", "clientId", "name", "redirectUris", "tokenEndpointAuthMethod", "applicationType",
	"grantTypes", "responseTypes", "scopes", "requirePKCE", "skipConsent", "disabled", "createdAt", "updatedAt"
) VALUES (
	'cue-windows', 'cue-windows', 'Cue for Windows', '["http://127.0.0.1/oauth/callback"]', 'none', 'native',
	'["authorization_code","refresh_token"]', '["code"]', '["openid","profile","email","offline_access"]',
	1, 1, 0, unixepoch() * 1000, unixepoch() * 1000
);

INSERT INTO "oauthClientResource" ("id", "clientId", "resourceId", "createdAt")
VALUES ('cue-windows-cue-api', 'cue-windows', 'https://api.cue.test', unixepoch() * 1000);
