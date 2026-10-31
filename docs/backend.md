# Cue backend and the Cue plan

Cue has one way to run: the **Cue plan**. Invited people sign in, and Cue's own backend (on
Cloudflare) does all the work with the owner's Anthropic and Deepgram keys. There are no local or
bring-your-own options: no Claude Code CLI, no Whisper, no FluidAudio, no API keys in the app.

**As much logic as possible lives in the backend**, because more clients follow (Windows next). A
client captures audio, shows the overlay and the dashboard, and talks to the Cue API; everything that
isn't tied to the operating system is the backend's.

## What runs where

| Concern | Today (Mac) | Backend | Client keeps |
|---|---|---|---|
| Sign-in, plan, limits | — | OAuth server, D1 | the browser sheet, the token in the keychain |
| Projects, settings, materials | files under `Application Support/Cue` | D1 + R2; text extracted from PDFs, Word files etc. with Workers AI `toMarkdown` | adding files (upload), showing them |
| Prepared answers (`KnowledgeBase.match`) | on the Mac | matched in the Call DO | showing them |
| Live transcript | whisper-server / Deepgram, `SpeechSegmenter` | Call DO → Deepgram live, endpointing and diarization there | capturing mic + call audio, streaming it |
| Spotting questions (`QuestionDetector`, judge) | on the Mac + Claude | Call DO on each final line → Haiku judge | showing the questions it's told about |
| Answers, Prepare Answer | Claude Code / API | Call DO → Sonnet, prompt cache kept warm | showing the streamed answer |
| Recording | `call.wav`, `me.wav` on disk | R2 (multipart upload after the call) | recording locally, uploading, retrying |
| Second pass, speakers | whisper-cli, FluidAudio | Workflow: Deepgram on the recording with `diarize`, each call-side line labelled by voice | — |
| Name suggestions, summary, notes | Claude, Markdown on disk | Workflow → Sonnet; the note stored in D1/R2 | rendering it; a Markdown copy in `Documents` (as today) |
| Renaming speakers, dismissing suggestions | edits the Markdown | `PATCH` on the note | the click |
| Call detection (apps on the mic), calendar | Core Audio, EventKit | the event ↔ project assignments, "record this call?" rules | reading the OS, asking, notifications |
| Overlay, dashboard, hot keys | SwiftUI | — | SwiftUI (Windows: its own UI) |

The session log stays the client's progress record (what cases wait on); the backend's progress
reaches it as events (`🔁 Improving transcript…`, `👥 Finding speakers…`, `✅ Speakers: N`,
`✍️ Writing summary…`, `💡 Suggested name: …`, `📝 Notes ready: …`), so the existing lines keep
their meaning.

**Privacy.** Calls' audio, transcripts and notes now live on Cloudflare (R2 and D1 encrypt at rest).
The recording's audio is deleted from R2 once the notes are ready plus 30 days (a setting); notes stay
until the user deletes them. Bodies and transcripts are never logged. The app says this at sign-in.

## Monorepo (Vite+ and pnpm)

```
package.json, pnpm-workspace.yaml   # apps/*, packages/*, tests/e2e; packageManager pnpm
vite.config.ts                      # root `lint` (oxlint, typeAware + typeCheck on tsgo) and `fmt` (oxfmt), overrides per package
apps/mac/                           # Package.swift, Sources/Cue, Resources, scripts
apps/api/                           # Elysia Worker: cloudflare.config.ts, src/, prompts/, migrations/
apps/admin/                         # the owner's admin SPA (Vite + React), served by the api Worker at /admin
packages/contract/                  # TypeBox schemas: the Cue API's requests, responses and call events
tests/e2e/                          # the end-to-end suite as a workspace package
```

- TypeScript 7, `vite-plus` (`vp check`, `vp lint`, `vp fmt`, `vp run`), oxlint and oxfmt through
  Vite+, pnpm. `vp test` is never used: unit tests are prohibited (AGENTS.md).
- Cloudflare through the `cf` CLI (`cf dev`, `cf build`, `cf deploy`, `cf d1 …`) with
  `cloudflare.config.ts` and `@cloudflare/vite-plugin@beta`. No wrangler config files.

## Backend (`apps/api`)

Elysia (`CloudflareAdapter`, `.compile()`), D1, R2, Durable Objects, Workflows, Workers AI
(`toMarkdown`), KV, Rate Limiting. Secrets: `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`,
`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `GITHUB_CLIENT_ID/SECRET`. Vars: `ANTHROPIC_URL`,
`DEEPGRAM_URL`, the identity providers' endpoints (e2e points them at stand-ins), `ADMIN_EMAILS`.
Prompts live in `apps/api/prompts/` (moved from the app's `Resources/prompt.md` and `judge.md`).

### Sign-in: OAuth 2.1, invite-only

- Better Auth with `@better-auth/oauth-provider`: the backend is an OAuth 2.1 authorization server.
  People sign in on its page with Google or GitHub (Generic OAuth plugin, endpoints from config).
- Invites are an email allowlist in D1; the first sign-in is accepted only with a provider-verified,
  invited email (`databaseHooks.user.create.before`), otherwise "Cue is invite-only".
- Clients are public clients: Authorization Code + PKCE (Mac: `ASWebAuthenticationSession`, redirect
  `com.andriishafar.cue:/oauth/callback`). Access token: JWT, 15 min, checked against the JWKS with no
  D1 read. Refresh token: rotating, 60 days, in the keychain. Sign Out revokes it; disabling a user
  revokes their tokens and puts them on a KV denylist.
- The owner (`ADMIN_EMAILS`) gets the `admin` role (Better Auth admin plugin) for the admin SPA.

### Cue API v1 (Cue's own API)

Bearer access token, `Cue-Version: <client and version>`. Errors: `{error: {code, message, retryable}}`
with `unauthorized`, `not_invited`, `limit_reached` (402), `rate_limited`, `upstream_unavailable`,
`upgrade_required` (426). Lists are paginated with cursors.

| Route | Does |
|---|---|
| `GET /v1/me` | Account, plan, limits, usage this month |
| `GET/POST/PATCH/DELETE /v1/projects[/:id]` | Projects and their settings (language, terms, notes on/off, …) |
| `POST /v1/projects/:id/materials`, `DELETE …/:materialId` | Upload a file (to R2), its text extracted and its prepared answers parsed |
| `POST /v1/calls` | Starts a call for a project (calendar event optional) → `callId` |
| `GET /v1/calls/:id/live` (WebSocket) | In: audio frames tagged by channel (`me`, `others`), and commands (`ask`, `prepare`, `show`). Out: events `transcript.partial/final {channel, speaker, text, start, end}`, `question {id, text}`, `answer.delta/done {questionId}`, `prepared {questionId, answer}`, `error`. |
| `POST /v1/calls/:id/questions` | Ask from the Ask field (also over the socket); SSE answer |
| `POST /v1/calls/:id/end` | Ends the call: the live transcript is saved, uploads can start |
| `PUT /v1/calls/:id/recording/:side` | Multipart upload of `me` / `others` audio to R2 (resumable) |
| `POST /v1/calls/:id/notes` | Starts the notes Workflow once the uploads are in |
| `GET /v1/notes[?project]`, `GET /v1/notes/:id` | Notes and their progress (`steps`, as the session log shows them) |
| `GET /v1/notes/:id/events` (SSE) | Progress events while the Workflow runs |
| `PATCH /v1/notes/:id` | Rename a speaker, apply or dismiss a name suggestion |
| `DELETE /v1/notes/:id` | Move to trash |
| `GET /v1/notes/:id/audio/:side` | Audio for playing from a timestamp (R2, range requests) |
| `GET/PUT /v1/calendar/assignments` | Which calendar series records into which project |

- **Call Durable Object**: builds the system prompt from the project's materials, writes the prompt
  cache and keeps it warm with alarms, holds the Deepgram live streams (with `diarize`), runs the
  question spotting and judge on each final line, matches prepared answers, answers questions, saves
  the live transcript to D1 when the call ends, and goes away when idle.
- **Notes Workflow** (Cloudflare Workflows, each step retried on its own): transcribe the recording
  (Deepgram, `diarize`, the project's terms) → label call-side lines by voice → suggest names
  (Sonnet) → summary (Sonnet) → note stored → progress events. If a step fails for good, the note keeps
  the live transcript and says what failed, as today.
- The server picks models. Usage (tokens per model, audio seconds) is priced by a table in config,
  recorded in D1; each user has a monthly dollar limit (402 over it) and a Rate Limiting binding.
- Never: the keys to a client, Deepgram's `callback` parameter, logged bodies or transcripts.
- Contract: TypeBox schemas in `packages/contract` (including the WebSocket events); Elysia serves the
  OpenAPI document; the Swift `Codable` types follow it (and the Windows client will too).

### Admin API

`/admin/v1/*`, same origin as the SPA, Better Auth session cookie with the `admin` role: overview
(spend this month, by user, by feature, per day), users (usage, limit, last active, disable / enable,
change limit), invites (add, list pending / accepted, revoke), settings (default limit, audio
retention, pause the whole plan). No transcripts or notes: the admin sees usage, not content.

## Admin SPA (`apps/admin`)

For the owner only, served by the api Worker as static assets at `/admin` (SPA fallback), so the
admin API is same-origin.

- React 19 with the React Compiler, Vite through Vite+, TypeScript 7 strict.
- TanStack Router (file-based, typed search params) and TanStack Query; Eden Treaty client typed from
  the api's exported `App` type.
- Base UI primitives; plain CSS with design tokens as custom properties, light and dark,
  `prefers-reduced-motion`; oxlint's react, react-hooks and jsx-a11y plugins.
- Designed with the `better-ui` and `emil-design-eng` skills: concentric radii, optical alignment,
  real hit areas, restrained purposeful motion with proper easing, no layout shift.
- Pages: Overview, Users (and one user), Invites, Settings. Sign in with Google / GitHub.

## The Mac app becomes a client

- First launch: Home shows Sign in and nothing else works until it succeeds; "not invited" is said
  plainly. Settings › Account: who's signed in, usage this month, Sign Out. Settings › Providers goes.
- `CueAPI.swift` (HTTP + the live WebSocket + Codable types from the contract) replaces
  `ClaudeService`, `ClaudeAPI`, `WhisperService`, `DeepgramService`, `SecondPass`, `Speakers`,
  `SpeechSegmenter`, `QuestionDetector`/`QuestionJudge`, `Summarizer`, `KnowledgeBase`/`Materials`
  parsing and the project and notes stores' file formats. The Swift package drops FluidAudio.
- Kept on the Mac: audio capture, call detection, the calendar, notifications, hot keys, the overlay
  and dashboard, the local recording and its upload, the Markdown copy of each note in `Documents`.
- Hooks: `CUE_API_URL=url`, `CUE_WEB_AUTH=headless` (follow the authorize URL with URLSession up to the
  redirect back); `CUE_CONTROL`: `signin`, `signout`. Hooks for removed pieces go. Document them in
  AGENTS.md and README.

## Testing (end-to-end only)

- Cases run the built app against the real Worker, DOs and Workflows under `cf dev` with local D1 and
  R2 (harness `cue.backend()`). Stand-ins only at the outer edge: `fake-providers.ts` for Anthropic
  and Deepgram (now the backend's upstreams; Deepgram's stand-in learns `diarize`), `fake-idp.ts`
  for Google / GitHub sign-in. `fake-claude.ts`, the speech probe and `needWhisper*` go.
- Existing cases keep checking what a user sees (notes, audio, the session log, windows); they are
  rewritten to run through the backend, so speech cases run on GitHub's runner too.
- New area `9x`: sign-in, limits and the usage display, materials uploaded and extracted, the admin
  SPA (Playwright against `cf dev`).

## PRs, in order (a stack: each is based on the one before; nothing merges to `main` until the owner says)

1. Monorepo: Vite+, pnpm, TypeScript 7, oxlint/oxfmt; the app moved to `apps/mac`. No behaviour change.
2. OAuth sign-in, `/v1/me`, the app's sign-in and Settings › Account.
3. Admin API and admin SPA.
4. Projects and materials on the backend (D1, R2, `toMarkdown`, prepared answers); the app's stores
   become API clients.
5. Live calls: Call DO, live WebSocket, question spotting, judge, answers, prepared answers; the app's
   live path moves to it; Claude Code, the Anthropic key, Whisper live and the Deepgram key go.
6. After the call: recording upload, the notes Workflow (second pass, speakers, names, summary), notes
   on the backend; whisper-cli, FluidAudio and the local summarizer go.
7. Limits and the usage display.
8. Deploy workflow on pushes to `main` touching `apps/api` or `apps/admin`.

## Risks (checked by the spike before PR 2)

Elysia's Cloudflare adapter under `cf` / `@cloudflare/vite-plugin@beta` inside Vite+; Elysia's types
under TypeScript 7; Better Auth + oauth-provider + JWT on D1; a Durable Object WebSocket through
Elysia; static assets with SPA fallback next to Elysia; large uploads (R2 multipart through the
Worker); Workflows and R2 under `cf dev`; Workers AI `toMarkdown` locally (it needs the network or a
stand-in).
