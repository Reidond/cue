import { bindings, defineConfig, exports } from 'cf/config';
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
        // The admin SPA (apps/admin) is Vite's client build, served under /admin with the single-page-app fallback. The fallback is not limited
        // to /admin, so everything the Worker itself answers is listed here: a navigation to it must never get the SPA's index.html, and under
        // `cf dev` an unlisted path gets Vite's own 404. Every new Worker route needs its prefix in this list.
        assets: {
            basePath: '/admin',
            notFoundHandling: 'single-page-application',
            htmlHandling: 'auto-trailing-slash',
            runWorkerFirst: [
                '/',
                '/admin/v1/*',
                '/v1/*',
                '/api/*',
                '/login',
                '/login/*',
                '/consent',
                '/invite-only',
                '/sign-in-failed',
                '/.well-known/*',
            ],
        },
        // One Call per live call: Deepgram's streams, the question judge and Claude's answers live in it (src/call/).
        exports: { Call: exports.durableObject({ storage: 'sqlite' }) },
        env: {
            CALL: bindings.durableObject({ worker: 'cue-api', exportName: 'Call' }),
            DB: bindings.d1(mode === 'development' ? { name: 'cue', id: DEV_DB_ID } : { name: 'cue' }),
            // User ids of disabled users: their access tokens (valid for up to 15 minutes) stop working at once.
            DENYLIST: bindings.kv(mode === 'development' ? { id: DEV_KV_ID } : {}),
            // The files people add to their projects (the originals; their text is in D1).
            MATERIALS: bindings.r2({ name: 'cue-materials' }),
            // Workers AI `toMarkdown` reads PDF and Word files. Workers AI always runs on Cloudflare, even under `cf dev`, where its binding
            // stops the dev server for want of a token: so the binding is left out unless AI_BINDING=1, and MARKDOWN_URL (the e2e suite's
            // stand-in, harness/fake-providers.ts) answers in `toMarkdown`'s shape instead. A real deploy sets AI_BINDING=1.
            AI: process.env.AI_BINDING === '1' ? bindings.ai() : false,
            MARKDOWN_URL: bindings.text(process.env.MARKDOWN_URL ?? ''),
            // The owner's keys: the backend does all the AI and speech work, so these never reach a client (nor does the user's token reach them).
            ANTHROPIC_API_KEY: secret(mode, 'ANTHROPIC_API_KEY'),
            DEEPGRAM_API_KEY: secret(mode, 'DEEPGRAM_API_KEY'),
            ANTHROPIC_URL: bindings.text(process.env.ANTHROPIC_URL ?? 'https://api.anthropic.com'),
            DEEPGRAM_URL: bindings.text(process.env.DEEPGRAM_URL ?? 'https://api.deepgram.com'),
            // Seconds: how often a live call looks whether its prompt caches (an hour long) need refreshing, how long a call must be quiet before
            // they are, and how long a call with no client connected is kept for it to come back. A case shortens them.
            CACHE_TICK_SECONDS: bindings.text(process.env.CACHE_TICK_SECONDS ?? '300'),
            CACHE_REFRESH_SECONDS: bindings.text(process.env.CACHE_REFRESH_SECONDS ?? '2700'),
            CALL_GRACE_SECONDS: bindings.text(process.env.CALL_GRACE_SECONDS ?? '120'),
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
