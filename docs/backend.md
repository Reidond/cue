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
The recording's audio is deleted from R2 once the notes are ready plus 30 days (a setting; at once with Keep audio off); notes stay
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

**Routing rule:** Elysia owns all routing. Every route is an Elysia route with typed params and
TypeBox schemas, grouped by feature; the Worker's `fetch` is the Elysia app's; Better Auth is mounted
through Elysia; Durable Objects are called through RPC methods on their stubs, and a DO's `fetch`
exists only for a WebSocket upgrade. No hand-written path matching (`pathname.endsWith`, regexes,
pre-Elysia dispatch) anywhere.

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
| `POST /v1/calls` | Starts a call for a project (calendar event, speaker, Auto, questions optional) → `callId` |
| `GET /v1/live?call=ID[&after=SEQ]` (WebSocket) | In: binary audio frames (a channel byte, `me` / `others`, then PCM16 mono 16 kHz) and commands (`config`, `ask`, `answerNow`, `prepare`). Out, each with a `seq`: `ready`, `status {part, state, detail}`, `speaking`, `transcript.partial/final {channel, speaker, text, start, end}`, `question {id, exchange, text, opener, requested, forced}`, `prepared {questionId, answer, source, score}`, `answer.delta/done {questionId}`, `error`, `ended`. `after` replays what a reconnecting client missed. At a fixed path rather than `/v1/calls/:id/live`: Elysia drops a route's 101 under `cf dev`, so the socket is `.mount`ed and has no params |
| `POST /v1/calls/:id/questions` | Ask from the Ask field (also over the socket); SSE of the same events |
| `POST /v1/calls/:id/end` | Ends the call: the live transcript is saved in D1 |
| `POST /v1/calls/:id/recording/:side?take=MS` | Begins the multipart upload of `me` / `others` / `mixed` audio to R2, or (the same call again) says which parts already arrived: the resume state |
| `PUT /v1/calls/:id/recording/:side?take=MS&part=N` | Uploads part N (the request body; 5 MiB or more except the last) |
| `POST /v1/calls/:id/recording/:side/complete?take=MS` | Finishes the upload from the parts that arrived |
| `POST /v1/calls/:id/notes` | Starts the notes Workflow once the uploads are in; the same `take` again is the same note |
| `GET /v1/notes[?project]`, `GET /v1/notes/:id` | Notes (newest first, without the trashed) and one note with its `steps`, as the session log shows them |
| `GET /v1/notes/:id/events[?after]` (SSE) | The Workflow's progress: `step`, `suggestion`, then `note` (ready); `Last-Event-ID` resumes |
| `PATCH /v1/notes/:id` | Rename a speaker (whole words, throughout), apply a suggested name, or dismiss it |
| `DELETE /v1/notes/:id` | Move to trash: gone from lists, audio deleted from R2 |
| `GET /v1/notes/:id/audio/:side` | Audio for playing from a timestamp (R2, range requests) |
| `PUT /v1/notes/:id/audio/mixed`, `POST /v1/notes/import` | A note the Mac had before it had an account (its Markdown taken apart) and its audio |
| `GET/PUT /v1/calendar/assignments` | Which calendar series records into which project |

- **Call Durable Object** (`apps/api/src/call/`, PR 5): builds the system prompt from the project's materials, writes the prompt
  cache and keeps it warm with alarms, holds the Deepgram live streams (Nova-3, `diarize` on the call side), runs the
  question spotting and judge on each final line (the waiting rules of the Mac's `QuestionDetector`: wait for the participant to finish, answer
  at once when the speaker starts talking, the room's microphone as `Room`), matches prepared answers, answers questions, records usage,
  saves the live transcript to D1 when the call ends, and ends a call nobody has come back to. A dropped client resumes: events carry a `seq` and the
  last thousand are replayed.
- **Notes Workflow** (`apps/api/src/notes/`, Cloudflare Workflows, each step retried three times on its own): `transcript` (Deepgram's recorded-file
  API, Nova-3, the project's language and terms, `diarize` on the call side, one utterance per line; the live transcript is kept when it
  hears much less than live recognition did) → `speakers` (each call-side line goes to the voice heard most while it was said, numbered in
  the order the voices first speak; the port of `Speakers.label`) → `names` (Sonnet suggests who the unnamed people are) → `summary` (Sonnet
  writes it; the port of `Summarizer` with `prompts/summary.md`) → `store` (note ready, audio dropped when Keep audio is off). A step that fails for
  good never stops the others: the note keeps what it had (the live transcript) and says what failed. Every step writes **events**
  (`note_event`: the session log's lines, `🔁 Improving transcript…`, `✅ Speakers: 2 …`, `💡 Suggested name: …`) that clients follow over
  SSE, and the `steps` of the note. Only the note's id goes between steps; the transcript lives in D1. A recording that stops while Cue goes on
  listening does not wait for the call to end: the live lines come from the Call DO (`lines()`).
- **Recordings** are uploaded in parts through the Worker (each under the 100 MB request limit) to R2 (`RECORDINGS`); the R2 binding cannot list
  parts, so each lands in `upload_part` (D1), which is the resume state. A call can hold several recordings, told apart by `take` (the start).
- **Retention**: a Durable Object (`Janitor`, one instance, an alarm) deletes the audio of notes `audioRetentionDays` (admin › Settings) after they
  were ready, aborts uploads nobody finished, and sleeps when no audio is in storage; a note becoming ready wakes it. Notes stay until deleted.
- The server picks models. Usage (tokens per model, audio seconds, files) is priced by one table (`apps/api/src/pricing.ts`: per model input / output /
  cache write / cache read per million tokens, Deepgram live and recorded per minute, `toMarkdown` per file), recorded in D1 (`usage`); see Limits below.
- Never: the keys to a client, Deepgram's `callback` parameter, logged bodies or transcripts.
- Contract: TypeBox schemas in `packages/contract` (including the WebSocket events); Elysia serves the
  OpenAPI document; the Swift `Codable` types follow it (and the Windows client will too).

### Limits

Each person has a monthly dollar limit (`user_limit`, else the admin's default, 20 USD) against the UTC month's `usage`. `/v1/me` reports the spend, the limit, the spend by
feature and the period (`periodStart`, `periodEnd`). Work that costs money does not start over the limit: `POST /v1/calls`, a question and a material answer `402 limit_reached`
with a sentence the app shows as it is. A call under way finishes the answer it is writing, then stops answering and says why over the socket (an `error` event
`limit_reached`, not fatal; transcription goes on, and answers flow again once the limit is raised or the month turns). The notes Workflow still stores the live transcript: the steps
that would spend money are marked failed with the limit as the reason, and the note says so (`⚠︎ Cue plan limit reached: the summary wasn't written …`). A call made only to hang a recording's
notes on (`notesOnly`) starts over already and is never stopped. Every authenticated request is also counted per user by a Rate Limiting binding (600 a minute; 30 a minute for what starts
a call or a question): over it `429 rate_limited`. The Mac shows the usage in Settings › Account, alerts once when the limit is reached, and says so in the overlay.

### Materials

A project's files are uploaded as the request body (`POST /v1/projects/:id/materials?name=`, streamed into R2; `Content-Length` required, 25 MB) and read
on the server: Markdown and text as they are, PowerPoint by the API itself (slides and speaker notes; the notes are where prepared answers live), and PDF, Word, spreadsheets,
HTML and the other formats Workers AI `toMarkdown` takes by `toMarkdown`. The text (at most a million characters) is kept in D1 beside the file's R2 key; a file that
can't be read is kept with the reason. `GET …/materials`, `GET …/materials/:id` (with the text), `DELETE …/materials/:id`, and `GET /v1/projects/:id/prepared-answers`, found in the
text with the project's language's question and answer labels (the port of the app's parser), which PR 5's Call DO matches questions against. Each `toMarkdown` file is a `usage`
row (`material_text`). Not yet: re-reading old files after the extractor improves, images, `.doc`/`.rtf`.

### Admin API

`/admin/v1/*`, same origin as the SPA, Better Auth session cookie with the `admin` role: overview
(spend this month, by user, by feature, per day), users (usage, limit, last active, disable / enable,
change limit), invites (add, list pending / accepted, revoke), settings (default limit, audio
retention, pause the whole plan). No transcripts or notes: the admin sees usage, not content.

| Route | Does |
|---|---|
| `GET /admin/v1/session` | Who the cookie belongs to (any signed-in account: the SPA shows "Not allowed" to a member) |
| `GET /admin/v1/overview[?month]` | The month's spend against the sum of everyone's limits, per day, per feature, top ten spenders |
| `GET /admin/v1/users[?q&status&sort&page]`, `GET …/users/:id[?month]` | Users with spend, limit, last activity and status; one user with spend per day and per feature |
| `POST …/users/:id/disable`, `…/enable`, `PATCH …/users/:id/limit` | Disable (ban, tokens revoked, KV denylist) and enable; a monthly limit, or `null` for the default |
| `GET/POST /admin/v1/invites`, `DELETE …/invites/:email` | Pending, accepted and disabled invites; add; withdraw one nobody has used |
| `GET/PATCH /admin/v1/settings` | Default monthly limit (20 USD), audio retention (30 days), pausing the plan |

Writes need this origin's `Origin` header. Money is millionths of a dollar in the `usage` table
(`user_id, feature, provider, model, units, unit, cost_micros, created_at`; PR 5 and 6 fill it: `answer`, `question_judge`, `live_transcript`, `note_transcript`, `note_names`, `notes_summary`), and the
limits are dollars: `user_limit` per person, else the `default_monthly_limit_usd` setting. A paused plan
(`plan_paused`, 503) is checked once per `/v1` request (`src/routes/v1.ts`); the admin is not under `/v1`.
Invite, enable, disable and revoke are one set of SQL statements (`src/accounts.ts`) shared by the admin
API and the owner's script.

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
- Pages: Overview, Users (and one user), Invites, Settings. Sign in with Google / GitHub (`/login/PROVIDER?next=admin`
  comes back to `/admin/`); a signed-in member sees "Not allowed".
- Built as the *client environment* of the api's Vite project (`apps/api/index.html` → `admin-entry.ts` → the SPA); `assets` in
  `cloudflare.config.ts` serves it at `/admin` with the SPA fallback, so every prefix the Worker answers is listed in `runWorkerFirst`.

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
  redirect back); `CUE_CONTROL`: `signin`, `signout`. Hooks for removed pieces go (`CUE_WHISPER_CLI`, `CUE_SPEAKER_MODELS`, `download speakers`). Document them in
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

They form GitHub Stack #21 (https://github.com/Reidond/cue/stack/21). Each new PR is appended with
`gh stack link 21 <PR number>`, and the whole stack is merged with `gh stack merge` once the owner approves.

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
