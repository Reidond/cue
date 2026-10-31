import { bindings, defineConfig } from 'cf/config';
import { DEV_DB_ID, DEV_KV_ID } from './dev-ids.ts';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

// Where sign-in with Google and GitHub goes. `IDP_URL` repoints both at a stand-in (the e2e harness' fake-idp.ts, which
// serves both providers' endpoints under /google and /github); a real deploy leaves it unset.
const idp = process.env.IDP_URL;
const endpoints = {
    GOOGLE_AUTHORIZE_URL: idp ? `${idp}/google/authorize` : 'https://accounts.google.com/o/oauth2/v2/auth',
    GOOGLE_TOKEN_URL: idp ? `${idp}/google/token` : 'https://oauth2.googleapis.com/token',
    GOOGLE_USERINFO_URL: idp ? `${idp}/google/userinfo` : 'https://openidconnect.googleapis.com/v1/userinfo',
    GITHUB_AUTHORIZE_URL: idp ? `${idp}/github/authorize` : 'https://github.com/login/oauth/authorize',
    GITHUB_TOKEN_URL: idp ? `${idp}/github/token` : 'https://github.com/login/oauth/access_token',
    GITHUB_USER_URL: idp ? `${idp}/github/user` : 'https://api.github.com/user',
    GITHUB_EMAILS_URL: idp ? `${idp}/github/user/emails` : 'https://api.github.com/user/emails',
};

// Secrets are Cloudflare secrets (set with `cf secrets`, never in the repository). Under `cf dev` they come from the environment `cf dev`
// was started in, with throwaway defaults, so a case (or a developer) needs no .dev.vars file and concurrent backends cannot overwrite each other's.
const secret = (mode: string | undefined, name: string) =>
    mode === 'development' ? bindings.text(process.env[name] ?? `dev-${name}-0123456789abcdef0123456789abcdef`) : bindings.secret();

// The development mode gives the database and the denylist fixed ids (dev-ids.ts); real deploys omit them, so `cf deploy` provisions both.
export default defineConfig(({ mode }) => ({
    worker: {
        name: 'cue-api',
        compatibilityDate: '2026-10-23',
        entrypoint,
        env: {
            DB: bindings.d1(mode === 'development' ? { name: 'cue', id: DEV_DB_ID } : { name: 'cue' }),
            // User ids of disabled users: their access tokens (valid for up to 15 minutes) stop working at once.
            DENYLIST: bindings.kv(mode === 'development' ? { id: DEV_KV_ID } : {}),
            BETTER_AUTH_SECRET: secret(mode, 'BETTER_AUTH_SECRET'),
            GOOGLE_CLIENT_ID: secret(mode, 'GOOGLE_CLIENT_ID'),
            GOOGLE_CLIENT_SECRET: secret(mode, 'GOOGLE_CLIENT_SECRET'),
            GITHUB_CLIENT_ID: secret(mode, 'GITHUB_CLIENT_ID'),
            GITHUB_CLIENT_SECRET: secret(mode, 'GITHUB_CLIENT_SECRET'),
            // The owner: comma-separated emails that are always invited and get the `admin` role.
            ADMIN_EMAILS: bindings.text(process.env.ADMIN_EMAILS ?? ''),
            // The issuer of the OAuth server, the origin the sign-in pages and the app's links go to.
            PUBLIC_URL: bindings.text(process.env.PUBLIC_URL ?? 'http://127.0.0.1:5173'),
            // Seconds; 15 minutes in production, shorter in a case that waits for one to run out.
            ACCESS_TOKEN_SECONDS: bindings.text(process.env.ACCESS_TOKEN_SECONDS ?? '900'),
            GOOGLE_AUTHORIZE_URL: bindings.text(endpoints.GOOGLE_AUTHORIZE_URL),
            GOOGLE_TOKEN_URL: bindings.text(endpoints.GOOGLE_TOKEN_URL),
            GOOGLE_USERINFO_URL: bindings.text(endpoints.GOOGLE_USERINFO_URL),
            GITHUB_AUTHORIZE_URL: bindings.text(endpoints.GITHUB_AUTHORIZE_URL),
            GITHUB_TOKEN_URL: bindings.text(endpoints.GITHUB_TOKEN_URL),
            GITHUB_USER_URL: bindings.text(endpoints.GITHUB_USER_URL),
            GITHUB_EMAILS_URL: bindings.text(endpoints.GITHUB_EMAILS_URL),
        },
    },
}));
