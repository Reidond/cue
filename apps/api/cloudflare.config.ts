import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindings, defineConfig, exports } from 'cf/config';
import { DEV_DB_ID, DEV_KV_ID } from './dev-ids.ts';
import * as entrypoint from './src/index.ts' with { type: 'cf-worker' };

// The backend's address, kept in one place (production-url.txt): the Worker's issuer here, and the Mac app, whose build stamps it into Info.plist
// (apps/mac/scripts/build.sh). `PUBLIC_URL` in the environment overrides it (a case's backend, a dry run elsewhere).
const productionUrl = readFileSync(join(import.meta.dirname, 'production-url.txt'), 'utf8').trim();

// The deployed denylist (the KV namespace "cue-api-denylist" the first deploy made; `cf kv namespaces list`).
const DENYLIST_ID = '4dd0de7bfe4e47578c46fb3fa972f3b7';

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

// Secrets are Cloudflare secrets (set with `cf workers secrets`, never in the repository; docs/deploy.md lists them). Under `cf dev` they come from the environment `cf dev`
// was started in, with throwaway defaults, so a case (or a developer) needs no .dev.vars file and concurrent backends cannot overwrite each other's.
const secret = (mode: string | undefined, name: string) =>
    mode === 'development' ? bindings.text(process.env[name] ?? `dev-${name}-0123456789abcdef0123456789abcdef`) : bindings.secret();

// Rate Limiting bindings count requests per user (src/limits.ts): every /v1 request against RATE_LIMIT, a request that starts paid work (a call,
// a question, a material) also against RATE_LIMIT_COSTLY. A period is 10 or 60 seconds. A case lowers them to see `rate_limited`.
const rate = (name: string, fallback: number) => {
    const value = Number(process.env[name]);
    return Number.isInteger(value) && value > 0 ? value : fallback;
};
const ratePeriod = process.env.RATE_LIMIT_PERIOD === '10' ? 10 : 60;

// The development mode gives the database and the denylist fixed ids (dev-ids.ts); real deploys omit them, so `cf deploy` provisions both.
export default defineConfig(({ mode }) => ({
    worker: {
        name: 'cue-api',
        compatibilityDate: '2026-10-23',
        entrypoint,
        // Served on the production address's own host (a custom domain: Cloudflare makes its DNS record and certificate on deploy), and only
        // there: the issuer and the sign-in cookies are that host's. No previews; watched in the dashboard.
        domains: mode === 'development' ? [] : [new URL(productionUrl).hostname],
        workersDev: false,
        previewUrls: false,
        observability: { enabled: true },
        // The admin SPA (apps/admin) is Vite's client build, served under /admin with the single-page-app fallback (from the root: no `basePath`,
        // which Cloudflare refuses to an account without it; apps/admin/vite.preset.ts puts the files where /admin finds them). The fallback is
        // not limited to /admin, so everything the Worker itself answers is listed here: a navigation to it must never get the SPA's index.html,
        // and under `cf dev` an unlisted path gets Vite's own 404. Every new Worker route needs its prefix in this list.
        assets: {
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
        exports: {
            Call: exports.durableObject({ storage: 'sqlite' }),
            // Deletes the audio of notes whose retention is over (src/notes/janitor.ts).
            Janitor: exports.durableObject({ storage: 'sqlite' }),
            // Makes the notes of a recording: the second pass, the voices, names, summary, the note stored (src/notes/workflow.ts).
            NotesWorkflow: exports.workflow({ name: 'cue-notes' }),
        },
        env: {
            CALL: bindings.durableObject({ worker: 'cue-api', exportName: 'Call' }),
            JANITOR: bindings.durableObject({ worker: 'cue-api', exportName: 'Janitor' }),
            NOTES: bindings.workflow({ name: 'cue-notes', worker: 'cue-api', exportName: 'NotesWorkflow' }),
            // The recordings of calls: each side's audio, uploaded in parts after the call (the notes Workflow reads them; they go after the retention).
            RECORDINGS: bindings.r2({ name: 'cue-recordings' }),
            // Seconds: a step of the notes Workflow that failed waits this long before trying again (three times); how long a "day" of audio
            // retention is and how often the janitor looks. A case shortens them.
            NOTES_RETRY_SECONDS: bindings.text(process.env.NOTES_RETRY_SECONDS ?? '5'),
            RETENTION_DAY_SECONDS: bindings.text(process.env.RETENTION_DAY_SECONDS ?? '86400'),
            RETENTION_TICK_SECONDS: bindings.text(process.env.RETENTION_TICK_SECONDS ?? '3600'),
            DB: bindings.d1(mode === 'development' ? { name: 'cue', id: DEV_DB_ID } : { name: 'cue' }),
            // User ids of disabled users: their access tokens (valid for up to 15 minutes) stop working at once. A KV binding has no name to be
            // found by (D1 and R2 have), so a deploy that provisioned it and then failed would try to make it again: the deployed one is pinned by id.
            DENYLIST: bindings.kv({ id: mode === 'development' ? DEV_KV_ID : DENYLIST_ID }),
            // Per user: 10 requests a second on average for everything (a sign-in's import of a library of notes is hundreds), 30 a minute for
            // what costs money. Namespace ids only have to differ within the account.
            RATE_LIMIT: bindings.rateLimit({ namespace: '4101', simple: { limit: rate('RATE_LIMIT_REQUESTS', 600), period: ratePeriod } }),
            RATE_LIMIT_COSTLY: bindings.rateLimit({
                namespace: '4102',
                simple: { limit: rate('RATE_LIMIT_COSTLY_REQUESTS', 30), period: 60 },
            }),
            // The files people add to their projects (the originals; their text is in D1).
            MATERIALS: bindings.r2({ name: 'cue-materials' }),
            // Workers AI `toMarkdown` reads PDF and Word files. Workers AI always runs on Cloudflare, even under `cf dev`, where its binding
            // stops the dev server for want of a token: so under `cf dev` the binding is left out unless AI_BINDING=1, and MARKDOWN_URL (the e2e
            // suite's stand-in, harness/fake-providers.ts) answers in `toMarkdown`'s shape instead. A deploy always has it.
            AI: mode !== 'development' || process.env.AI_BINDING === '1' ? bindings.ai() : false,
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
            PUBLIC_URL: bindings.text(process.env.PUBLIC_URL ?? (mode === 'development' ? 'http://127.0.0.1:5173' : productionUrl)),
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
