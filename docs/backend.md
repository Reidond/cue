# Cue backend and the Cue plan

Cue has one way to run: the **Cue plan**. Invited people sign in, and Cue's own backend (on
Cloudflare) does all the Claude and speech work with the owner's Anthropic and Deepgram keys. There are
no local or bring-your-own options: no Claude Code CLI, no Whisper, no API keys in the app. Signing in is
part of first launch; until then Cue shows only the sign-in.

Removed once the Cue plan covers what they do:

- Claude (PR 4): `ClaudeService` (the `claude` CLI), `ClaudeAPIService` / `AnthropicAPI`,
  `ClaudeProvider`, `APIKey.anthropic`, `CUE_CLAUDE_BIN`, `CUE_ANTHROPIC_URL`, `tests/e2e/tools/fake-claude.ts`,
  `--real-claude` / `--real-anthropic`. The prompts (`Resources/prompt.md`, `judge.md`) move to
  `apps/api/prompts/`.
- Speech (PR 5): `WhisperService` (whisper-server), the second pass's `whisper-cli`, the speech model
  download, `DeepgramService`, `SpeechProvider`, `APIKey.deepgram`, `CUE_WHISPER_PORT`,
  `CUE_WHISPER_CLI`, `CUE_DEEPGRAM_URL`, `--real-deepgram`, `needWhisper` / `needWhisperCli` and the
  speech probe in `harness/capabilities.ts`.
- Settings › Providers becomes Settings › Account.

Speaker diarization (FluidAudio on the Mac) stays: it's part of how notes are made, not a provider option.
The e2e cases that used the removed pieces are rewritten against the Cue plan. As a result, speech
cases no longer need a GPU and can run on GitHub's runner. `fake-providers.ts` stays as the backend's
upstreams.

## Monorepo (Vite+ and pnpm)

```
package.json, pnpm-workspace.yaml   # apps/*, packages/*, tests/e2e; packageManager pnpm
vite.config.ts                      # root `lint` (oxlint, typeAware + typeCheck on tsgo) and `fmt` (oxfmt), overrides per package
apps/mac/                           # Package.swift, Sources/Cue, Resources, scripts (moved as they are)
apps/api/                           # Elysia Worker: cloudflare.config.ts, src/, migrations/
apps/admin/                         # the owner's admin SPA (Vite + React), served by the api Worker at /admin
packages/contract/                  # TypeBox schemas shared by api, admin and the e2e harness
tests/e2e/                          # the existing suite as a workspace package (pnpm-lock replaces package-lock)
```

- Tooling: TypeScript 7 (`typescript@^7`), `vite-plus` (`vp check`, `vp lint`, `vp fmt`, `vp run`),
  oxlint and oxfmt through Vite+, pnpm workspaces. `vp test` is never used: unit tests are prohibited
  (AGENTS.md); everything is verified by end-to-end cases.
- Cloudflare: the `cf` CLI (`cf dev`, `cf build`, `cf deploy`, `cf d1 …`) with `cloudflare.config.ts`
  and `@cloudflare/vite-plugin@beta`. No wrangler config files.

## Backend (`apps/api`)

Elysia (`CloudflareAdapter`, `.compile()`), D1, Durable Objects, KV, Rate Limiting binding.
Secrets: `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET`,
`GITHUB_CLIENT_ID/SECRET`. Vars: `ANTHROPIC_URL`, `DEEPGRAM_URL`, the identity providers' endpoints
(so e2e cases point them at stand-ins), `ADMIN_EMAILS`.

### Sign-in: OAuth 2.1, invite-only

- Better Auth with `@better-auth/oauth-provider`: the backend is an OAuth 2.1 authorization server.
  People sign in on its page with Google or GitHub (Generic OAuth plugin, endpoints from config).
- Invites are an email allowlist in D1. The first sign-in is accepted only when the provider has
  verified the email and it's invited (`databaseHooks.user.create.before`); otherwise "Cue is invite-only".
- The Mac app is a public client: Authorization Code + PKCE in `ASWebAuthenticationSession`, redirect
  `com.andriishafar.cue:/oauth/callback`. Access token: JWT, 15 min, checked against the backend's JWKS
  with no D1 read. Refresh token: rotating, 60 days, in the keychain (`APIKey.cue`). Sign Out revokes it.
  Disabling a user revokes their refresh tokens and puts them on a KV denylist.
- The owner (`ADMIN_EMAILS`) gets the `admin` role (Better Auth admin plugin) for the admin SPA.

### Cue API v1 (Cue's own API, not a mirror of Anthropic's or Deepgram's)

Bearer access token, `Cue-Version: <app version>`. Errors: `{error: {code, message, retryable}}` with
`unauthorized`, `not_invited`, `limit_reached` (402), `rate_limited`, `upstream_unavailable`,
`upgrade_required` (426).

| Route | Does | Runs on |
|---|---|---|
| `GET /v1/me` | Account, plan, limits, usage this month | D1 |
| `POST /v1/calls` | Starts a call: project materials, language, terms, quality `fast`/`best` → `callId` | Call Durable Object |
| `POST /v1/calls/:id/questions` | Answers a question; SSE `text {delta}`, `done {usage}`, `error {…}` | Call DO → Sonnet |
| `POST /v1/calls/:id/judgements` | `{speech, channel}` → `{questions: […]}` | Call DO → Haiku |
| `GET /v1/calls/:id/speech` (WebSocket) | Binary audio frames tagged with their channel in; `partial` / `final` `{channel, text, start, end}` out | Call DO → Deepgram, a stream per channel |
| `DELETE /v1/calls/:id` | Ends the call | Call DO |
| `POST /v1/transcriptions` | A recording + language + terms → `{utterances: [{start, end, text}]}` (second pass) | Worker → Deepgram |
| `POST /v1/summaries` | Transcript + project → SSE summary | Worker → Sonnet |

- The Call DO builds the system prompt from `apps/api/prompts/prompt.md` (and the judge's from
  `judge.md`, imported as text) plus the materials, writes the
  prompt cache before the first question and keeps it warm with alarms while the call is quiet, keeps
  the questions and answers, holds the Deepgram streams and ends after it's been idle.
- The server picks models; the app sends `fast`/`best`.
- Usage per request (tokens per model, seconds of audio) priced by a table in config, recorded in D1.
  Each user has a monthly dollar limit; over it → 402. Per-user Rate Limiting binding.
- Never: your keys to the client, Deepgram's `callback` parameter, logged bodies or transcripts.
- Contract: TypeBox schemas in `packages/contract`; Elysia serves the OpenAPI document; the Swift
  `Codable` types follow it.

### Admin API

`/admin/v1/*`, same origin as the SPA, Better Auth session cookie with the `admin` role:
overview (spend this month, by user and by feature, per day), users (usage, limit, last active,
disable / enable, change limit), invites (add, list pending / accepted, revoke), settings (default
limit, pause the whole plan).

## Admin SPA (`apps/admin`)

For the owner only. Served by the api Worker as static assets at `/admin` (SPA fallback), so the admin
API is same-origin: cookie auth, no CORS.

- React 19 with the React Compiler, Vite through Vite+, TypeScript 7 strict.
- TanStack Router (file-based, typed search params) and TanStack Query; Elysia's Eden Treaty client
  typed from the api's exported `App` type, so the admin can't drift from the API.
- Accessible headless primitives (Base UI); plain CSS with design tokens as custom properties,
  light and dark, `prefers-reduced-motion` respected; oxlint's react, react-hooks and jsx-a11y plugins.
- Designed with the `better-ui` and `emil-design-eng` skills: concentric radii, optical alignment,
  real hit areas, restrained purposeful motion with proper easing, no layout shift, fast perceived loads.
- Pages: Overview, Users (and one user), Invites, Settings. Sign in with the same Google / GitHub.

## The Mac app

- First launch: Home shows Sign in (Google / GitHub) and nothing else works until it succeeds;
  "not invited" is said plainly.
- Settings › Account: who's signed in, a usage bar for this month, Sign Out.
- `CueAPI.swift`: `CueCall` (answers and the judge), `CueSpeech` (live speech), and calls for
  summaries and the second pass. Until PRs 4 and 5 land, the existing providers keep working beside it.
- Hooks: `CUE_API_URL=url` (the backend), `CUE_WEB_AUTH=headless` (follow the authorize URL with
  URLSession instead of the browser sheet, up to the redirect back); `CUE_CONTROL`: `plan cue|own`,
  `signin`, `signout`. Session log: `🤖 Claude: Cue plan`, `🗣 Speech recognition: Cue plan`,
  `🔑 Signed in to Cue as …`, `⚠︎ Cue plan limit reached: …`. Document them in AGENTS.md and README.

## Testing (end-to-end only)

- Cases run the built app, the real Worker and DOs under `cf dev` with local D1 (harness `cue.backend()`).
  Stand-ins only at the outer edge: `fake-providers.ts` for Anthropic and Deepgram (now the backend's
  upstreams), a new `fake-idp.ts` for Google / GitHub sign-in.
- New area `9x`: sign-in (invited, not invited, refresh, sign out, disabled, refresh-token reuse);
  answers, judge and summaries through the plan; live speech and the second pass through the plan;
  limits and the usage display; the admin SPA (Playwright against
  `cf dev`: invite someone, change a limit, disable a user, see spend).

## PRs, in order

1. Monorepo: Vite+, pnpm, TypeScript 7, oxlint/oxfmt; move the app to `apps/mac`; CI and release updated.
   No behaviour change.
2. OAuth sign-in and `/v1/me`, the app's sign-in and Settings › Account; first deploy to `*.workers.dev`.
3. Admin API and admin SPA.
4. Calls: Call DO, answers, judge, summaries; the app's `CueCall`; Claude Code and the Anthropic key removed.
5. Speech: live WebSocket and `/v1/transcriptions`; the app's `CueSpeech`; Whisper and the Deepgram key removed.
6. Limits and the usage display.
7. Deploy workflow on pushes to `main` touching `apps/api` or `apps/admin`.

## Risks (checked by the spike before PR 2)

Elysia's Cloudflare adapter (experimental) under `cf` / `@cloudflare/vite-plugin@beta` inside Vite+;
Elysia's types under TypeScript 7; Better Auth + oauth-provider + JWT on D1 in Workers; returning a
Durable Object's WebSocket upgrade through Elysia; static assets with SPA fallback next to Elysia routes;
uploading a long recording in one request.
