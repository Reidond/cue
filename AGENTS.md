# Working on Cue

Cue is a macOS overlay prompter and call notetaker: SwiftPM executable in
`apps/mac/Sources/Cue`, resources in `apps/mac/Resources/`, built into
`apps/mac/build/Cue.app` by `apps/mac/scripts/build.sh`. See `README.md` for
what it does. `docs/backend.md` is the design of the Cloudflare backend and
admin app that are being added beside it.

## Layout

The repository is a Vite+ (`vp`) pnpm monorepo:

```
package.json, pnpm-workspace.yaml   # apps/*, packages/*, tests/e2e; pnpm-lock.yaml is the only lockfile
vite.config.ts                      # the one lint (oxlint) and fmt (oxfmt) configuration, overrides per package
apps/mac/                           # the Swift app: Package.swift, Sources/Cue, Resources, scripts/build.sh
apps/api/                           # the Cue API: an Elysia Worker on Cloudflare (cloudflare.config.ts, src/, migrations/, scripts/)
apps/admin/                         # the owner's admin SPA (React): built as the api Worker's client assets, served at /admin
packages/contract/                  # TypeBox schemas of the API's requests and responses
tests/e2e/                          # the end-to-end suite, a workspace package
scripts/changelog.sh                # release notes; repo-wide, used by the release workflow
docs/                               # plan.md (the app), backend.md (the backend)
```

- Install: `pnpm install` (Node 26 or later, pnpm from `packageManager`; `vp` is
  the `vite-plus` dev dependency, run it as `pnpm vp …` or with the global `vp`).
- Check: `vp check` formats, lints and type-checks all TypeScript in one go (`vp check --fix`
  applies fixes). Run it before you commit. Never use `vp test`: unit tests are prohibited.
- Lint and format settings live only in the root `vite.config.ts`; add package
  rules as `lint.overrides` / `fmt.overrides` there, not as config files in packages.
- TypeScript is 7 (`typescript@^7`); type-aware linting runs on its native compiler (tsgo).

## The backend (`apps/api`)

Cue is a client of its own Cloudflare backend (`docs/backend.md` is the design). Signing in (Google or GitHub, invite-only) is
the only way to use the app. Work on it in a Boat sandbox like everything else (`cf dev`, `cf build`, installs).

- Elysia on Cloudflare Workers, Better Auth with `@better-auth/oauth-provider` (the backend is an OAuth 2.1 server), D1 and KV.
  The toolchain has three settings that must stay: the `vite@*` override and `autoInstallPeers: false` in `pnpm-workspace.yaml`, and
  no `vite` dependency in `apps/api` (`node apps/api/scripts/check-vite.ts` fails when `cf` would use upstream Vite; CI runs it).
- **Routing rule: no hand-written routing.** No `pathname.startsWith(…)` / `endsWith` / regex dispatch on a request's path, and no `fetch`
  in front of Elysia that switches on paths: every HTTP route is an Elysia route with typed `params` / `query` / `body` and TypeBox
  schemas, grouped by feature in a plugin under `src/routes/` (`.use()`d from `src/index.ts`), and the Worker's `fetch` is the Elysia
  app's. Better Auth is `.all('/api/auth/*', …)` handing it the untouched request. Durable Objects are called through RPC methods on
  their stubs (`stub.keepWarm()`), never `fetch` with a path; a DO's `fetch` exists only for the WebSocket upgrade, which the route
  hands over with Elysia's own mechanism and a one-line comment saying why (PR 5 finds it: a plain route's 101 is dropped under `cf dev`).
- A route that must read its own body (Better Auth, raw uploads) needs a parser that claims the body: `parse: () => true`. Elysia
  otherwise reads it first and the handler fails with "ReadableStream is locked"; `parse: 'none'` is ignored under `cf dev`. Elysia
  compiles ahead of time only in production (`aot: !import.meta.env.DEV`; workerd forbids `Function(…)` under `cf dev`), so check a
  route in both: `cf dev`, and `cf build --mode development` served by `vp preview`.
- Routes return errors as `{error: {code, message, retryable}}` (`packages/contract`). The OpenAPI document is `/v1/openapi.json`.
- Better Auth's tables are generated from the same config the Worker uses: `pnpm --filter api schema` rewrites
  `migrations/0002_better_auth.sql` (do it whenever a plugin or an auth option changes). Other migrations are plain SQL files.
- Types of the Worker's bindings come from `cf workers types` (`apps/api/.cloudflare/types`, git-ignored): run
  `pnpm --filter api types` before `vp check` in a fresh checkout (CI does).
- Secrets and endpoints are in `apps/api/cloudflare.config.ts`. Under `cf dev` the secrets are text bindings read from the environment
  (`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, …) with throwaway defaults, so there is no `.dev.vars` to keep apart; `IDP_URL` repoints both
  identity providers at a stand-in, `PUBLIC_URL` is the issuer, `ACCESS_TOKEN_SECONDS` the access token's life (900), `PORT` and
  `CUE_STATE_DIR` the dev server's port and persisted state. Nothing is deployed from here: `pnpm --filter api deploy:dry` only (`docs/deploy.md` is the owner's checklist; `.github/workflows/deploy.yml`
  deploys on pushes to `main`). The backend's production address is kept in `apps/api/production-url.txt`: the Worker's issuer (`PUBLIC_URL` outside `cf dev`) and, stamped into `Info.plist` by
  `apps/mac/scripts/build.sh`, the Mac app's default (`CUE_API_URL` overrides it). In a deploy the `AI` binding is always on, `ADMIN_EMAILS` comes from the environment `cf deploy` runs in, and
  `scripts/migrate-remote.ts` applies the migrations to the deployed D1 (found by name; `--if-exists` for the run before the first deploy).
- The owner's script: `pnpm --filter api invite EMAIL` (invite), `… EMAIL --disable` (disable: banned, tokens revoked, on the KV
  denylist so access tokens stop working at once), `… --list`. It works on the local database (`pnpm --filter api migrate` first); with
  `--remote` it goes through `cf d1 raw` and `cf kv keys` to the deployed one, finding it by name (`CUE_D1_ID` / `CUE_KV_ID` name them
  when that fails). The remote path has not run against a real account yet. A user is invited or an `ADMIN_EMAILS` address
  (always invited, the `admin` role); only a provider-verified email may sign in.

## Projects and materials (`apps/api` `/v1/projects`, `apps/mac/Sources/Cue/Projects.swift`)

A person's projects (name, occasion, language, names and terms) and their materials live in D1 and R2; `docs/backend.md` › Materials has the design.

- **Routes**: `src/routes/projects.ts` (CRUD and `…/prepared-answers`) and `src/routes/materials.ts`, both behind the `authed` plugin (`src/routes/authed.ts`,
  which gives a route `userId`); `src/projects.ts` has the row types. Every query carries the user id: another person's project is `not_found`, never `forbidden`.
  Schemas are in `packages/contract/src/projects.ts` (and the Swift side's `ProjectsAPI.swift` follows them by hand).
- **An upload** is `POST /v1/projects/:id/materials?name=NAME`, the file as the body (`Content-Length` required, `Content-Type` its type, 25 MB at most).
  The route has `parse: () => true`, so Elysia leaves the body alone and it streams into R2 (`MATERIALS`); the server then reads it back, extracts the text and keeps
  it in D1 (`material.text`, with the extractor's `qa` blocks for a slide deck's speaker notes). The same file again (name and ETag) is the same material; the same
  name with other contents gets " 2". A file whose text can't be read is kept with `error` (the app shows it); only a failing converter (`upstream_unavailable`) fails the upload.
- **Extraction** (`src/materials/`): `.md`/`.markdown`/`.txt` as they are; `.pptx` by the API itself (`slides.ts`, `fflate` + a small XML tokenizer, the port of the app's
  `OfficeXML`); everything else Workers AI `toMarkdown` (`markdown.ts`). `cf dev` can't run Workers AI without a token, so the `AI` binding is left out unless
  `AI_BINDING=1` and `MARKDOWN_URL` points at a stand-in speaking `toMarkdown`'s shape: `harness/fake-providers.ts` serves it (`/markdown`, noted as
  `markdown-request`, reading Word and PDF files built by `harness/documents.ts`). A real `toMarkdown` run is not covered by any case. Each file it reads is a `usage` row
  (`material_text`, provider `cloudflare`, unit `files`, priced by `PRICING.toMarkdown` in `src/pricing.ts`, now 0: documents are free).
- **Prepared answers** are found when asked for (`src/materials/prepared.ts`, the port of `Materials.extractQA`), in the project's language (`lexicon.ts` holds the question and
  answer labels; English ones always count), so changing the language changes them.
- **The Mac app**: `ProjectStore` is the account's projects plus a folder each in the library, for the notes until PR 6. `Project.id` stays the folder name (notes and calendar
  assignments point at it); `Project.serverID`, in `project.json`, is the account's project. After sign-in (`CueAPI.onSignedIn`, before `Signed in` is logged) `syncWithAccount` lists the
  account's projects, makes a folder for the ones this Mac hasn't seen, and uploads every folder without a `serverID` once (`📦 Imported N projects from this Mac`).
  Create, rename, delete and adding or removing a file wait for the server; field edits are saved here at once and to the account after 0.8 s (`☁️ Saved “NAME” to your account`).
  `CUE_CONTROL` commands run one after another, so `new` and `add` finish before the next line. `KnowledgeBase` builds Claude's prompt from the server's text.
- **AoT**: `E2E_BACKEND=preview node tests/e2e/run.ts --no-app 26 27` runs the same cases against the compiled Worker (`cf build --mode development`, `vp preview`), where Elysia compiles its routes ahead of time.
- **In a case**: `backend.call(method, path, token, { body | file })`, `backend.accountOf(email)` (`Account`: `projects()`, `materials()`, `text()`, `answers()`) and
  `backend.rows(sql)` and `backend.objects()` (R2 keys) check the account from outside the app; `makeDocx`/`makePdf`/`makePptx`/`writeFile` build the files.

## Limits and usage (`apps/api/src/{pricing,limits,usage}.ts`)

What a person may spend, and what stops them. `docs/backend.md` › Limits has the design; the shapes are `Me` in `packages/contract/src/index.ts`.

- **One price table**: `PRICING` in `src/pricing.ts` (per model input / output / cache write / cache read tokens per million, Deepgram live and recorded per minute,
  `toMarkdown` per file; millionths of a dollar, list prices to check before the first deploy). Every `usage` row is built by `tokenUsage`, `speechUsage` or
  `markdownUsage` there: a new thing that costs money is a line in the table and one of those, nowhere else.
- **A month's allowance**: `limitState(db, userId)` (`src/usage.ts`): the UTC month's `usage` against `user_limit`, else the admin's default. Over it (spend >= limit; a
  limit of 0 stops everything) is `limit_reached` (402, not retryable) with a sentence the app shows as it is ("You've used $20.00 of your $20.00 Cue plan for this month. It
  starts over on November 1 (UTC).").
- **Where it is checked** (`src/limits.ts`): `mayStartCostlyWork(userId)` (the stricter rate, then the allowance) opens `POST /v1/calls` and `POST /v1/calls/:id/questions`; a material upload asks `mustBeWithinLimit` only (the first sign-in uploads a whole library at once). Not checked: a call with `notesOnly` (the Mac's call just for a recording's notes: a row that starts ended, no Durable Object, free), the notes `POST`, uploads of
  recordings, everything that costs nothing.
- **In a call** (`call.ts` `#withinLimit`): before each answer the call writes its usage and looks at the allowance. Over it: no answer is started (an answer under way is
  finished), a question the person asked gets the sentence as its `answer.done` `error`, one Cue noticed is not listed (the judge is not asked), and one `error` event
  `{code: 'limit_reached', fatal: false}` tells the client (a client that connects later gets it too). Transcription goes on. It is looked at again on every alarm tick and
  every 30 s by the judge, and for each answer, so a raised limit lets answers flow again at once.
- **In the notes Workflow**: before a step that spends money (the second pass, a speakers pass that must read the call side again, names, summary) a `… limit` step asks
  `limitState`; over it the step is `failed` with the reason `Cue plan limit reached` and the session-log line `⚠︎ Cue plan limit reached: the summary wasn't written — the transcript
  is kept` (the others: see `LIMITED` in `workflow.ts`). The note is ready with the live transcript.
- **Rate limits**: Cloudflare Rate Limiting bindings, per user id: `RATE_LIMIT` (600 a minute, every authenticated `/v1` request, in the `authed` plugin and the socket) and
  `RATE_LIMIT_COSTLY` (30 a minute, what `mayStartCostlyWork` guards: calls and questions). Over: `rate_limited` (429, retryable). A case lowers them with `RATE_LIMIT_REQUESTS`, `RATE_LIMIT_PERIOD`
  (10 or 60) and `RATE_LIMIT_COSTLY_REQUESTS` in `cue.backend({ env })`; the limiter is eventually consistent per location in production.
- **`/v1/me`** reports `limits.monthlyUsd`, and `usage`: `usd`, `audioSeconds`, `limitReached`, `byFeature` (dearest first), `periodStart`, `periodEnd`.
- **The Mac**: `CueMe` decodes them; Settings › Account has the usage bar (`UsageBar`), the limit, when it starts over and where the money went. `AppState.planLimit` is set by
  a `limit_reached` from `POST /v1/calls`, by the socket's `error` event, or by `/v1/me` (`CUE_ME_TICK`) saying `limitReached`: an alert once (`⚠︎ Cue plan limit reached: SENTENCE`), the
  overlay's status line says "Plan limit reached", and `🔓 Cue plan has room again` when it clears (a raised limit, a new month, an answer arriving).
- **In a case** (`9d-…`, all but `9d-limit-app` and `9d-limit-overlay` run with `--no-app`): `backend.setLimit(owner, email, usd | null)` (the admin API; the backend needs
  `adminEmails`) and `backend.seedUsage` put a person over or under; `cue.backend({ env: { RATE_LIMIT_REQUESTS: '6', RATE_LIMIT_PERIOD: '10', … } })` makes `rate_limited` easy to see.

## The admin (`apps/api` `/admin/v1`, `apps/admin`)

The owner's admin: usage and money, never content (no transcripts, no notes). `docs/backend.md` › Admin API says what it covers.

- **API**: `src/routes/admin.ts`, a plugin under `/admin/v1`, authorized by a Better Auth session cookie whose user is an owner (`admin` role or
  `ADMIN_EMAILS`): no session `401`, a member `403` (`GET /admin/v1/session` alone answers a member, so the SPA can say "Not allowed"). A write
  must carry this origin's `Origin` header. Schemas are in `packages/contract/src/admin.ts`; money is dollars in the contract and millionths of a
  dollar in the `usage` table; times are milliseconds. Settings (default monthly limit, audio retention, pausing the plan) are rows of `setting`;
  `src/routes/v1.ts` is the `/v1` group (the plan gate, then each feature's plugin: `me`, PR 4's projects, …), and a paused plan makes every route in
  it answer `plan_paused` (503). `/v1/me` reads the limit (`user_limit`, else the default) and the month's usage from `usage` (see Limits and usage).
- **One code path for who may use Cue**: `src/accounts.ts` holds the SQL of invite, enable, disable and revoke (plain TypeScript, no
  `cloudflare:workers`); the admin API runs it through `env.DB.batch`, the owner's script (`scripts/invite.ts`) through `cf d1 raw`. Disabling also
  puts the user on the KV denylist (`denylistKey`).
- **The SPA** (`apps/admin`: React 19 with the React Compiler, TanStack Router file routes and Query, Eden typed from the api's `App`, Base UI, plain
  CSS tokens in `src/styles/tokens.css`) is the *client environment* of the api's Vite project: `apps/api/index.html` and `admin-entry.ts` are the
  entry, `apps/admin/vite.preset.ts` the plugins, `assets` in `cloudflare.config.ts` serve it under `/admin` with the SPA fallback. The fallback
  is not limited to `/admin`: **every prefix the Worker itself answers must be in `assets.runWorkerFirst`** (`/`, `/v1/*`, `/admin/v1/*`, `/api/*`,
  `/login*`, …), or a navigation gets the SPA's `index.html` (and `cf dev` Vite's own 404). `src/routeTree.gen.ts` is generated (by `cf dev` or
  `cf build`) and committed. Signing in is the Worker's `/login/PROVIDER?next=admin`, which comes back to `/admin/`.
- Eden turns date-looking strings into `Date`s; the client is made with `parseDate: false`. Toggles are optimistic (`src/lib/queries.ts`: snapshot,
  patch, roll back on error, invalidate): a case that checks the server after one must wait for it (`cue.waitFor`), not read it at once.
- Lint: oxlint's `react` (with the react-hooks rules) and `jsx-a11y` plugins are on for everything in the root `vite.config.ts`.

## Live calls (`apps/api/src/call`, `apps/api/src/routes/calls.ts`, `apps/mac/Sources/Cue/LiveCall.swift`)

A call is one stretch of listening (Start Cue, or a recording): the Mac streams the microphone and the call audio to a **Call Durable Object** and shows
what its events say. `docs/backend.md` has the design; the shapes are `packages/contract/src/calls.ts` (the Swift side follows them by hand).

- **Routes**: `POST /v1/calls` (project, optional event, speaker, auto, micQuestions, questions → `callId`), `POST /v1/calls/:id/questions` (the Ask field, SSE of the
  same events), `POST /v1/calls/:id/end`, and the socket **`GET /v1/live?call=ID[&after=SEQ]`** (not `/v1/calls/:id/live`: see below). Calls are the user's: another
  person's is `not_found`.
- **The socket is `.mount`ed** (`routes/calls.ts` `live`, a fixed path with the call in the query) because Elysia rebuilds every `Response` a route returns and
  that drops the Durable Object's `webSocket` under `cf dev`; `.mount` hands the request over untouched. A mounted handler runs before Elysia's hooks in
  that mode, so it checks the bearer token and the plan itself, and no `:id` param is available (hence `?call=`). The Durable Object is called through RPC
  (`begin`, `ask`, `end`); its `fetch` is only the upgrade. `src/call/stub.ts` types the namespace (the generated types cannot follow a Worker's binding to itself).
- **In**: binary frames (one byte channel, 0 `me` / 1 `others`, then PCM16 LE mono 16 kHz, contiguous: the server's clock is the samples) and JSON commands
  `config`, `ask`, `answerNow`, `prepare`. **Out**: `ready`, `status` (part `speech|claude|judge`), `speaking`, `transcript.partial|final`, `question`, `prepared`,
  `answer.delta|done`, `error`, `ended`, each with a `seq`; the last 1000 are kept, and `after=SEQ` replays what a reconnecting client missed. A call with no client for
  `CALL_GRACE_SECONDS` (120) ends by itself. The reading rules (`show`, `newest`, holding the view) stay on the Mac: they are UI.
- **The Durable Object** (`call.ts`) wires: `deepgram.ts` (a live stream per channel, Nova-3, `diarize` on `others`, endpointing 700 ms, KeepAlive, reopened when it
  drops), `detector.ts` / `judge.ts` (ports of `QuestionDetector` / `QuestionJudge`: the waiting rules, Haiku with `prompts/judge.md`), `knowledge.ts` (the system
  prompt from `prompts/prompt.md`, the project's prepared answers and materials; `Matcher` is `KnowledgeBase.match`), `session.ts` (a Claude conversation:
  system prompt cached for an hour and written before the first question with `max_tokens: 0`, the conversation cached too, history kept; `anthropic.ts` the Messages
  client with the retries), `lexicon.ts` (language names, stop words, openers). Echo lines (the microphone hearing the call) are dropped before anyone sees them.
- **Alarms** (`CACHE_TICK_SECONDS` 300): each tick warms a session quiet for `CACHE_REFRESH_SECONDS` (2700), records usage and ends an abandoned call.
- **Usage** (`usage` table, flushed each tick and at the end): `answer` and `question_judge` rows per model for input / output / cache write / cache read tokens,
  `live_transcript` audio seconds per stream (both channels are billed), `notes_summary` tokens (the notes Workflow also writes `note_transcript` audio seconds per side and `note_names` tokens). Prices are the one table in `src/pricing.ts` (list prices, not checked
  against an invoice); the limit is enforced (see Limits and usage).
- **Secrets**: `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, endpoints `ANTHROPIC_URL`, `DEEPGRAM_URL` (cases point them at `fake-providers.ts`). The user's token goes to neither.
- **The Mac** (`LiveCall.swift`, `AppState`): `createCall` / `endCall` when capture starts / stops, the socket with reconnects (backoff, `after=`) and `AudioSink`
  (frames; silence is filled by the host clock so the server's clock keeps up), events drive the same `Exchange` / `Answer` state as before.

## Notes (`apps/api/src/notes`, `routes/recordings.ts`, `routes/notes.ts`, `apps/mac/Sources/Cue/{NotesAPI,NoteMarkdown,Recordings}.swift`)

After a call the recording goes up and the backend makes the notes. `docs/backend.md` has the design; the shapes are `packages/contract/src/notes.ts`
(the Swift side follows them by hand).

- **Recording upload**: `POST /v1/calls/:id/recording/:side?take=MS` begins (or, again, resumes) a multipart upload of `me` / `others` / `mixed` to R2 (`RECORDINGS`),
  `PUT …&part=N` sends part N as the request body (`parse: () => true`; **5 MiB at least except the last, and local R2 enforces it**), `POST …/complete` finishes.
  The R2 binding cannot list parts, so each lands in `upload_part` (D1): that is the resume state. `take` is the recording's start in ms (a call can hold several recordings).
- **Notes**: `POST /v1/calls/:id/notes` (the uploads are complete; the same `take` returns the same note) saves the live lines (the call row, or the Call DO's `lines()`
  when the call goes on), makes the `note` row and starts **`NotesWorkflow`** (`src/notes/workflow.ts`, bound `NOTES`). Steps `transcript` (Deepgram recorded-file API, Nova-3,
  `tag=me|others`, `diarize` on the call side, keyterms from the project; echo and `sideLost` rules ported from the app) → `speakers` (the port of `Speakers.label` on the words'
  voices) → `names` (Sonnet, `prompts/names.md`) → `summary` (Sonnet, `prompts/summary.md`; remarks about the transcript dropped, title taken) → `store`. Each step is retried
  three times (`NOTES_RETRY_SECONDS` apart); one that fails for good is marked failed and the next runs: the note keeps what it had. Only the note id goes between steps; the working
  transcript is in D1 (`note.lines`, `note.voices`, `note.transcript`).
- **Progress**: every step writes `note_event` rows whose `line` is the session-log line (`🔁 Improving transcript…`, `✅ Transcript improved: N segments (X s for M:SS of audio)`,
  `⚠︎ Couldn't improve the transcript: WHY — the live transcript is kept`, `👥 …`, `✍️ …`, `💡 Suggested name: …`); `GET /v1/notes/:id/events` streams them as SSE (an Elysia generator route,
  `Last-Event-ID`/`?after`, `ping` heartbeats, ends after the `note` event) and `steps` on `GET /v1/notes/:id` is the page's list. A Workflow that dies is noticed by the stream and the note is
  made ready with a `note: failed` event.
- **Editing**: `PATCH` renames a speaker throughout the note (whole words: transcript, summary, title, participants), applies or dismisses a suggestion; `DELETE` trashes (audio deleted at once);
  `GET …/audio/:side` serves R2 with range requests. `POST /v1/notes/import` and `PUT /v1/notes/:id/audio/mixed` bring in a note the Mac had before it had an account.
- **Retention**: the `Janitor` Durable Object (`src/notes/janitor.ts`, bound `JANITOR`, one instance, an alarm) deletes audio `audioRetentionDays` after a note was ready (Keep audio off: when
  the notes are ready) and aborts abandoned uploads. `RETENTION_DAY_SECONDS` (86400) and `RETENTION_TICK_SECONDS` (3600) shorten it in a case.
- **The Mac**: `save` writes the live-transcript note exactly as before, then `RecordingStore.process` uploads (`RecordingUploader`: parts of `CUE_UPLOAD_PART_BYTES`, retries, resume;
  `CUE_UPLOAD_BREAK=n` cuts the connection once), starts the notes (with a call just for them when none is live), follows the events — each `line` goes to the session log verbatim —
  and when the note is ready writes the server's note into the Markdown copy in `Documents` (front matter `note: ID`). `RecordingStore` still reads the library's files; after sign-in
  `syncWithAccount` imports notes without a `note:` (`📦 Imported N notes from this Mac`) and writes the account's notes the library lacks (`☁️ Restored N notes from your account`).
  Rename, Apply, ✕ and Move to Trash are `PATCH` / `DELETE` and then the same file edits as before; the player streams `…/audio/mixed` when the `.m4a` isn't on disk.

## Cloud sandboxes (Boat)

Use a Boat sandbox for builds, tests, untrusted code, Docker, and long jobs.
Never run them on this computer.
Docs: https://docs.boat.dev/llms.txt. Prices and limits: run `boat limits`;
never quote prices from memory.
Source: https://docs.boat.dev/ai-tools#3-add-a-rule-to-agents-md.

- Create: `id=$(boat new --json | jq -r 'select(.event=="ready") | .id')`.
- One-shot job: `boat run --push . -- <command>` creates a sandbox, runs the
  repository command, reports its cost and deletes it; it returns the command's
  exit code.
- Run: `boat exec "$id" --cwd cue "pnpm install && pnpm vp check"`
  (30 s timeout; `--timeout 0` means no limit).
- Server: `boat exec "$id" --detach "<server-command>"`, then
  `boat exec "$id" --status <pid>`.
- Copy files: `boat push "$id" ./cue` (git-tracked and non-ignored files, to
  `/home/user/cue`) or clone the repo inside the sandbox.
- Private URL for a port: `boat ssh "$id" "host 3000 --private"`.
- Always pass the sandbox ID. `current` does not work in a non-interactive shell.
- When done: `boat stop "$id"` keeps the disk for 14 days;
  `boat delete "$id" --yes` erases it.

Boat supplies Linux VMs. Run portable checks such as `vp check` there. Building `Cue.app` and running its end-to-end suite require macOS and Apple
frameworks: use the existing macOS CI runner or an explicitly authorized remote
Mac, never this computer. The macOS test and snapshot recipes below apply on that
runner; a Linux check is not evidence that the app builds or passes its native
cases. Report unavailable native checks as not-run or skipped with their reason.
An SSH connection does not keep a sandbox alive: check `boat info "$id"` and
extend its lifetime before long work.

## Testing: end-to-end only — unit tests are prohibited

This rule is strict and has no exceptions.

- **Never write unit tests.** Do not add XCTest or Swift Testing, a
  `testTarget` in `apps/mac/Package.swift`, a `Tests/` folder, `XCTestCase` / `@Test` /
  `#expect`, mocks or fakes of Cue's own types, or code (protocols, injection
  points, `internal` widening) that exists only so a unit test can call it.
  If you find any, delete them.
- **Every change is verified by an end-to-end case** in `tests/e2e/cases/`
  that runs the built `Cue.app` — the app itself, or its command-line modes
  (`--render`, …) — against real files, real audio and real child processes
  (and the real backend under `cf dev`), and checks what a user would see:
  the notes on disk, the audio files, the session log, the rendered windows.
- **The suite's browser is Playwright** (`playwright-core` in `tests/e2e`; it downloads nothing): `harness/browser.ts` drives the machine's Chrome
  headless (`E2E_BROWSER=path` names another; macOS CI has Chrome, a Boat sandbox has `/usr/bin/google-chrome`; a machine without one skips the
  case) for the cases that use the admin SPA as its owner does. Never for the Mac app, which is driven by `CUE_CONTROL`.
- Stand-ins are allowed only at the outer boundary, never for Cue's own code:
  - the paid cloud providers the backend calls: `harness/fake-providers.ts` serves the Anthropic Messages API and Deepgram's live speech-to-text
    (live and recorded files) from the case's own process, as the backend's upstreams (`ANTHROPIC_URL`, `DEEPGRAM_URL`), and takes only the owner's keys in `FAKE_KEYS`
    (the backend gets them as `ANTHROPIC_API_KEY` / `DEEPGRAM_API_KEY`). The Anthropic one answers as `FAKE_CLAUDE_ANSWER` sets (`FAKE_CLAUDE_ANSWERS`
    one per question matching a pattern; as the question judge it finds the sentences ending in "?", or replies as `FAKE_CLAUDE_JUDGEMENTS` says,
    and `FAKE_CLAUDE_JUDGE_FAILS=1` makes it fail, `FAKE_CLAUDE_JUDGE_DELAY` slow; `FAKE_ANTHROPIC_OVERLOADED=N` answers the judge's first N
    requests with a 529, `FAKE_ANTHROPIC_CUT=N` breaks off the first N answers partway), simulates the prompt cache and reports `usage`. The
    Deepgram one takes a continuous stream of PCM per channel, tells speech from silence by loudness, and answers each stretch of speech (an
    utterance, ended by 700 ms of quiet) with the next line of `FAKE_DEEPGRAM_LIVE` (a JSON array in the order utterances start across both
    channels; an entry is a string, or `{text, speaker}` for the call side) or "Utterance N."; `FAKE_DEEPGRAM_DROP=N` drops the connection of
    the Nth utterance as it starts. For the notes Workflow it also reads a recorded file (`POST /v1/listen`): one utterance per stretch of speech in it,
    worded by `FAKE_DEEPGRAM_FILE` (a JSON object `{"me": […], "others": […]}`, entries as above, in order; a side without an entry says "Second pass by Deepgram, part N."),
    with each word's `speaker` when the request has `diarize` (`FAKE_DEEPGRAM_FILE_FAILS=N` fails the first N such requests with a 500, `FAKE_DEEPGRAM_FILE_DELAY` slows them);
    the Anthropic one has a second system prompt kind, the names step ("You find the names…"), answered by `FAKE_CLAUDE_NAMES` (a JSON object label → name; by default the
    `<!-- speaker: … -->` lines of the summary's fixture), and `FAKE_ANTHROPIC_SUMMARY_FAILS=N` fails the first N summaries. The variables are read from the environment the app was launched with (`cue.launch({…})`) or from
    `cue.standIns({…})` for a case with no app. `--real-deepgram` points the backend at the real Deepgram instead, with the key the runner
    reads from the login keychain (item `Cue e2e Deepgram API key`, added with `security add-generic-password -a "$USER" -s "…" -w`): never
    put a real key in a case, a fixture, the control file or the chat. A recording of a real call (someone's conversation) never goes into
    the repository either: case 84 reads one from `E2E_REAL_CALL=path` (any recording macOS can read, a screen recording's `.mov` too) and
    skips without it;
  - Google and GitHub sign-in: `tests/e2e/harness/fake-idp.ts` serves both providers' endpoints from the case's process (the backend
    reaches it through `IDP_URL`) and approves as whoever the case chose with `backend.idp.approveAs(email)`; nothing else of sign-in is
    faked;
  - system sources that need the user's permission or a live person (the
    microphone, call audio, the calendar database, which apps use the
    microphone, the answer to a notification): an environment hook feeds the
    input at the exact point where Cue reads it from the system (as
    `CUE_REHEARSE_*` does for audio), and everything after that point runs
    for real.
- A feature is done when its case passes: `node tests/e2e/run.ts` (all
  cases) or `node tests/e2e/run.ts 20-` (cases whose name starts with `20-`).
  Report the PASS / FAIL / SKIP summary, with the failing output, in the PR
  description.
- A case that needs something the machine lacks (a voice, a permission, the network, Chrome) calls `skip('reason')` or a `need…` helper; it
  never fakes the missing piece.
- Some Macs can't do what certain cases need: GitHub's runners may not draw the overlay readably. Before the
  cases, `run.ts` probes the machine once (`harness/capabilities.ts`): the dashboard's snapshot must read as text, and so must the overlay's once Start
  Cue shows it. A case that depends on what's missing skips with that reason: the snapshot helpers
  (`snapshotText`, `dashboardPage`, `dashboardShows`) for windows and the
  overlay. Call `needWindowSnapshots()` or `needOverlaySnapshots()` yourself
  before reading a snapshot another way. The speech cases need no probe: the live transcript and the notes' second pass are the backend's
  (with the stand-ins), so they run on any Mac, and on Linux for the backend's own.

### The backend in a case

Cue is for signed-in people, so every case that launches the app runs against the real backend: `apps/api` under `cf dev`, with
local D1 and KV, started by the case.

- **Each case has its own backend** (`cue.backend()`, `tests/e2e/harness/backend.ts`; `cue.launch()` starts it for you): its own port,
  its own database in the case's folder, its own stand-in sign-in and the Anthropic and Deepgram stand-ins of
  `fake-providers.ts` as its upstreams (`ANTHROPIC_URL`, `DEEPGRAM_URL` in the Worker's environment). The alternative, one backend for
  the whole run, would fix what the backend calls upstream when it starts; a case could not say what Anthropic or Deepgram answer
  without a router in between that knows which user is which case. Per case it is simply what the stand-ins of that case say, and
  cases stay independent and safe to run from several checkouts at once (ports are free ones, state is under `E2E_WORK`). The price is
  `cf dev`'s start, about 6 s a case (dependencies are optimized once per checkout, the first case waits longer).
- `cue.launch()` signs in: it invites `cue.email`, makes the stand-in approve as them, launches Cue with `CUE_API_URL` and
  `CUE_WEB_AUTH=headless`, sends `signin` and waits for `🔑 Signed in to Cue as …`. A relaunch finds its refresh token and signs in by
  itself. `cue.launch({…}, { signIn: false })` launches signed out, for a case that drives the sign-in; `{ backend: {…} }` gives
  `cue.backend()` its options (`accessTokenSeconds`, `adminEmails`, `env`). `cue.refreshToken` is the token Cue keeps, `cue.signedIn`
  whether it has one.
- The backend's own cases need no app: `node tests/e2e/run.ts --no-app 95 96 97 9a-` builds nothing, needs no Swift tools, and runs on
  Linux (a Boat sandbox) too (all of `9a-` but `9a-admin-disable-app`, which signs the Mac app out). They use `backend.tokensFor(email)`, `backend.signInAs(email, { provider, verified })`,
  `backend.refresh(token)`, `backend.revoke(token)`, `backend.get(path, accessToken)`, `backend.invite(email)` and
  `backend.disable(email)` (the owner's script), the stand-in `backend.idp` and `backend.log` (the Worker's output). The admin's:
  `backend.adminAs(email)` (an `AdminClient` with the session cookie a browser would get: `get`, `call(method, path, body, origin)`),
  `backend.seedUsage(email, rows)` (rows of the `usage` table, as the backend writes them) and `AdminPage.signIn(backend, email, { scheme, viewport,
  shots })` (`harness/browser.ts`: the SPA in a browser, signed in through the stand-in provider; `.page` is Playwright's, `.shot(name)` writes a
  screenshot into the case's sandbox, `.assertClean()` fails on console errors, exceptions and 5xx, `.navigate('Users')` follows the navigation).
- **Recordings and notes without the app** (`9c-…`): `harness/recordings.ts`. `recordCall(cue, backend, email, …)` makes a call (optionally live, so the Call DO holds lines) and the two
  sides' WAVs; `uploadRecording(backend, token, callId, side, take, file, { partBytes, breakAt })` uploads in parts the way the app does and can lose the connection partway
  (a real cut socket) and resume; `startNotes` / `makeNotes` start the Workflow, `waitForNote` waits for `ready`, `noteEvents` reads the SSE stream (`after`, `lastEventId`),
  `getNote`; `account.notes(project?)` / `account.note(id)` read a person's notes from outside the app. Parts must be 5 MiB or more (R2's rule, enforced by the local R2 too):
  generate long audio (`bursts` writes it instantly) when a case needs several. `cue.backend({ env: { NOTES_RETRY_SECONDS, RETENTION_DAY_SECONDS, RETENTION_TICK_SECONDS } })` shortens
  a retry's wait and the retention's "day". `cue.serviceRequests('deepgram-file')` reports the recorded-file requests.
- **Live calls without the app** (`9b-live-…`, also Linux-friendly): `startCall(backend, email, { materials, language, namesAndTerms, call })` signs in,
  makes a project with the files as materials and starts a call; `LiveClient.connect(backend, token, callId, after?)` is the app's socket
  (`play(channel, pcm)` streams audio in real time, `command({…})`, `next(type, check, seconds)` waits for an event, `of(type)`, `answerTo(questionId)`,
  `drop()`); `bursts(out, seconds, [[from, to]…])` writes loud sound where the Deepgram stand-in should hear speech and silence elsewhere (no
  voices needed), `pcmOf(wav)` its samples; `cue.standIns({…})` says how the stand-ins reply; `cue.backend({ env: {…} })` can shorten
  `CACHE_TICK_SECONDS`, `CACHE_REFRESH_SECONDS` and `CALL_GRACE_SECONDS`. `cue.serviceRequests('anthropic-request' | 'deepgram-live')` and
  `cue.claudeRequests(kind)` report what reached the stand-ins (a Deepgram stream is noted when it ends).

### Running the cases

The suite is TypeScript run by Node 26 or later, which strips the types
itself: no build step, no transpiler, no runtime packages.

```bash
node tests/e2e/run.ts                  # build the app, then run every case
node tests/e2e/run.ts --no-build 4 5   # the existing build; cases whose name starts with 4 or 5
node tests/e2e/run.ts --no-app 95-     # no app at all: only cases about the backend (they run on Linux, in a Boat sandbox)
node tests/e2e/run.ts --real-deepgram 83 84   # the backend's Deepgram is the real one, its key from the keychain
node tests/e2e/run.ts --keep           # keep every sandbox (a failed case always keeps its own)
pnpm install && vp check               # format, lint, type-check; run it before you commit
```

The runner compiles the Swift tools in `tests/e2e/tools/` that need Apple's
frameworks (`ocr`, `dialogue`, `audio-sync`, `windows`) when their source
changes, runs the cases one at a time (each a `node:test` test in its own
process), and prints one line per case with the failing output. Everything a run makes —
sandboxes, each case's log, the tools, the dialogue and speaker-model caches
— is in `E2E_WORK` (by default one folder per checkout under `$TMPDIR`).
A run stays out of the way of whoever is using the Mac: every Cue it launches
has `CUE_BACKGROUND=1`, so it never comes to the front or takes focus, and its
windows stay behind all others, where snapshots still capture them. Every
Cue it launches is in US English too (`-AppleLocale en_US`), whatever the
Mac's region, so cases can look for `$2.50` and `Nov 1`. A snapshot taken on
screen shows only what is scrolled into view (an offscreen one, as on CI,
can show more): a case that reads text far down a page makes the window tall
enough first (`size W H`).

### Writing a case

Each case is a TypeScript file, `tests/e2e/cases/NN-name.test.ts`, numbered
by feature area (`0x` CLI and launch, `1x` prompter and recording, `2x`
projects and dashboard, `3x` call audio, `4x` the notes' second pass (upload, steps, retries), `5x`
speakers, `6x` calendar, `7x` the backend's Anthropic calls, `8x` Deepgram through the backend, `9x` signing in, the backend and the admin: the admin's are `9a-…`, the live calls' `9b-…`, the notes' `9c-…`, the limits, usage and rate limits' `9d-…`). It declares one test, whose title says the
behaviour it checks:

```ts
import { assertContains, dialogue, e2eCase, fixture } from '../harness/index.ts';

e2eCase('A two-sided rehearsal is recorded into notes with both sides.', async (cue) => {
    const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
    await cue.launch({
        FAKE_DEEPGRAM_LIVE: call.live(), // the live transcript, from the stand-in
        FAKE_DEEPGRAM_FILE: call.file(), // the second pass over the recording, from the stand-in
        CUE_REHEARSE_RECORD: '1',
        CUE_REHEARSE_PARTICIPANT: call.wav('call'),
        CUE_REHEARSE_ME: call.wav('me'),
    });
    await cue.waitLog(/Notes ready/, 180);
    assertContains(cue.readyNotes(), /^## Transcript/);
});
```

`e2eCase` hands the case `cue`, a sandboxed Cue, and stops it and cleans up
after it whatever happens; a failed case keeps its sandbox. Helpers that only
read files (the assertions, `cue.sessionLog()`, `lines`, …) are synchronous;
anything that runs a process or waits returns a promise — await it. From
`tests/e2e/harness/index.ts`:

- the sandbox, `cue`: `cue.home` (`CUE_HOME`, a fresh folder holding
  `Application Support/Cue` — `cue.support` — and `Documents` —
  `cue.documents`), its own defaults domain, all
  wiped after the case, so checkouts can run cases at the same time; the calendar and the apps
  using the microphone are read from the case's own files, never from the
  Mac. `cue.path(…)` is a path in the case's folder, `cue.save(name, text)`
  writes a file there, `cue.project(name, settings)` makes a project by hand;
  `cue.keysFile` is where Cue keeps its refresh token under `CUE_HOME`;
- driving Cue: `cue.defaults(key, value)` (typed by the value: string, bool,
  number or array), `cue.launch({ VAR: 'value' })`, `cue.stop()`,
  `cue.alive()`, `cue.pid`, `cue.cli(…args)` (command-line modes),
  `cue.control(command)` (what a click would do, through `CUE_CONTROL`), `cue.calendar([events])`
  (with times from `minutesFromNow(n)` and `tomorrowAt('HH:MM')`),
  `cue.micApps(…bundleIds)` (who is on the microphone now; none when the call
  app lets go);
- waiting and reading what Cue did: `cue.waitFor(what, seconds, check)`,
  `cue.waitLog(regex, seconds)`, `cue.sessionLog()`, `cue.logCount(regex)`,
  `cue.readyNotes()`, `cue.findNotes()`, `cue.claudeRequests(kind)` (what the backend
  sent the Anthropic API's stand-in), `cue.serviceRequests(kind)`
  (how the backend called the cloud stand-ins: model, key, caching, Deepgram's query,
  keyterms and audio), `cue.dashboardPage(page, regex)` and
  `cue.dashboardShows(regex)` (show a dashboard page and read its snapshot
  into `cue.page`), `cue.snapshotText(png)`; `summaryOf(notes)` (a note's
  summary, without the transcript), `lines`, `countLines` and `matches` (as
  `grep`, `grep -c` and `grep -o` would), `findFiles`, `listDir`;
- audio and screens: `speech(out, voice, text)` and `dialogue(script, out)`
  (multi-voice calls built with `say`: `wav(side)` per side plus `timeline`),
  `silence(out, seconds)` (a call where nobody speaks), `excerpt(recording, out, from,
  seconds)` (a stretch of any recording, as 16 kHz WAV), `ocr(png)`,
  `appWindows(cue.pid)` (whether Cue is the active app, has a Dock icon, and
  its windows on screen with their levels), `afinfo(file)`,
  `audioLength(file)`, `audioSync(audio, timeline, …sides)` (each line of a dialogue where its timeline puts it,
  silence elsewhere), `turnSpeakers(notes, timeline)` and `labelsOf` (each
  line of a dialogue with its voice and the label of the transcript turn it
  starts);
- results: `assertFile`, `assertContains`, `assertNotContains` (regexes
  matched line by line, ignoring case, as `grep -i -E` would), `assertEq`,
  `assertBetween`, `fail(message, …dumps)`, `skip(reason)`, and
  `needWindowSnapshots`,
  `needOverlaySnapshots`, `needRealDeepgram`, `needVoice`, `needReachable`.

Look at the existing cases before writing a new one, and keep each case
focused on one user-visible behaviour. Write only TypeScript that Node can
strip: `.ts` in imports, `type` on imports of types, no `enum`, `namespace`
or constructor parameter properties (`tsconfig.json` checks this).

### Test hooks in the app

Hooks are environment variables read at launch; keep them out of normal
code paths and document new ones here and in `README.md` › Testing.

| Variable | Effect |
|---|---|
| `CUE_HOME=dir` | All files under `dir`, settings in the `com.andriishafar.cue.e2e` domain (`apps/mac/Sources/Cue/Storage.swift`), the refresh token in `dir/Keychain.json` instead of the login keychain (`apps/mac/Sources/Cue/CueAPI.swift`); windows don't remember their frames (AppKit would keep them in the user's own settings). |
| `CUE_DEFAULTS_DOMAIN=name` | With `CUE_HOME`, keep settings in this defaults domain. |
| `CUE_UPLOAD_PART_BYTES=n` | The size of the parts a recording is uploaded in (default 8 MiB; the backend wants 5 MiB at least for all but the last). |
| `CUE_UPLOAD_BREAK=n` | Lose the upload's connection once, as the part after the first `n` sent in this launch is about to go: the upload starts over from the parts the server has. |
| `CUE_NO_LIVE_AUDIO=1` | Don't open the microphone or call audio. |
| `CUE_REHEARSE_PARTICIPANT=wav` / `CUE_REHEARSE_ME=wav` | Play a file as the call / as your microphone, in real time; a recording gets its audio too (digital silence on the call side is left out, as ScreenCaptureKit delivers nothing while the Mac is silent). |
| `CUE_REHEARSE_RECORD=1` | Record the rehearsal and write its notes. |
| `CUE_SNAPSHOT=png` | Every 2 s, the overlay to `png`, and the dashboard and Settings, when open, to `…-dashboard.png` / `…-settings.png` (whole window, at the display's scale). With Screen Recording access these are the windows' real pixels from ScreenCaptureKit — glass, materials, selection — in the system appearance; without it (CI), or for a window that isn't on screen (the overlay before Start Cue), the app draws the window offscreen instead (layout and text only, light appearance). The session log says which: `📸 Snapshots: window capture (…), in the dark appearance` or `📸 Snapshots: offscreen, … — reason`, and `📸 Overlay: …` when one window differs. The overlay is capturable while this is set. |
| `CUE_SNAPSHOT_METHOD=m` | How `CUE_SNAPSHOT` takes them: `desktop` (the default: each window over the desktop picture alone, so its glass refracts real pixels yet no other window covers it or shows through), `window` (the window alone: the overlay's glass over nothing), `display` (what's on screen behind the window now, other apps included, minus whatever is in front of it) or `offscreen` (the fallback, forced). |
| `CUE_APPEARANCE=light\|dark` | Use this appearance instead of the system's. |
| `CUE_PROJECT=name` | Make this project active at launch, creating it if there is none by that name. |
| `CUE_CONTROL=file` | Run each line appended to `file` as a click would: `new NAME` (New Project), `add PATH` (drop a file on the open project's materials), `start NAME` (Start Cue), `project NAME` (the overlay's project menu), `page home\|upcoming\|NAME\|NAME/answers\|NAME/notes` (show a dashboard page), `ask TEXT` (the Ask field), `timestamp HH:MM:SS` (a timestamp in the open note's transcript: plays its audio from there), `assign EVENT \| PROJECT` (an Upcoming call's project picker, by event title), `notification record\|dismiss` (Record / Not Now on the latest prompt), `rename NAME \| NEW` (a speaker's name clicked and renamed in the open note), `apply LABEL` / `dismiss LABEL` (Apply or ✕ on a name suggestion of the open note), `show TEXT` (the overlay's row of the question with TEXT in it), `newest` (the overlay's New Questions button), `prepare` (Prepare Answer on the newest questions waiting for it), `record` (the overlay's record button, or Stop Recording in its timer's menu), `settings general\|account\|calendar` (Settings on that tab), `set PROJECT | occasion|language|names | VALUE` (a field of the project's page edited), `remove PROJECT | FILE` (a material's minus button), `size W H` (the dashboard's edge dragged until it's W × H points, or as small as it goes), `signin` (Sign In on Home) and `signout` (Sign Out in Settings › Account). Until someone is signed in only `signin`, `signout`, `settings`, `page` and `size` do anything (the rest log `⚠︎ Sign in to Cue first (…)`). Notifications then go only to the session log (`🔔 …`), not Notification Center, so no permission is asked. |
| `CUE_CALENDAR_EVENTS=file.json` | Read the calendar from this file instead of EventKit (no permission asked), again on every check: a JSON array of `{title, start, end}` (ISO 8601) with optional `id`, `series` (shared by a recurring event's occurrences), `calendar` (name), `url`, `location`, `notes`, `attendees` (names), `recurring`. |
| `CUE_MIC_APPS=file` | The bundle IDs using the microphone right now, one per line, read on every check instead of Core Audio's process list. |
| `CUE_MEETING_TICK=s` / `CUE_MIC_RELEASE=s` | Check for calls every `s` seconds instead of 5; stop a call's recording once the call app has been off the microphone for `s` seconds instead of 60. |
| `CUE_API_URL=url` | The Cue API (`CueAPI.baseURL`, default `https://api.cue.app`): the backend a case runs. |
| `CUE_WEB_AUTH=headless` | Sign in without the browser sheet: `CueAPI` follows the authorize URL with `URLSession` (cookies, the sign-in page's Google button) up to the redirect back to the app, which it keeps. |
| `CUE_ME_TICK=s` | Read the account (`/v1/me`: usage, still allowed?) every `s` seconds instead of 300; a signed-out Cue with a saved refresh token tries again at the same pace. |
| `CUE_ALLOW_CAPTURE=1` | Let screenshots see the overlay. |
| `CUE_SHOW_SETTINGS=1` | Open Settings at launch. |
| `CUE_BACKGROUND=1` | Stay out of the way of whoever is using the Mac (`cue.launch` sets it for every case): Cue never activates itself or takes keyboard focus, and has no Dock icon, menu bar icon or hot keys; its windows sit behind every other window — just above the desktop picture, under the desktop's icons, in every Space — where `CUE_SNAPSHOT` still captures each one alone (drawn as an inactive app's window). An alert goes only to the session log (`⚠︎ …`) instead of waiting for a click. |

To look at a design you changed, run the app in a sandbox with snapshots on, show the page,
and read the PNGs as images — then the same in the other appearance:

```bash
home=$(mktemp -d)
CUE_HOME=$home CUE_NO_LIVE_AUDIO=1 CUE_SHOW_SETTINGS=1 CUE_APPEARANCE=dark \
  CUE_SNAPSHOT=$home/cue.png CUE_CONTROL=$home/control apps/mac/build/Cue.app/Contents/MacOS/Cue & pid=$!
sleep 3; echo "new Bee talk" >> "$home/control"   # any CUE_CONTROL line: `page home`, `start NAME`, …
sleep 5; ls "$home"/*.png                         # cue.png (overlay), cue-dashboard.png, cue-settings.png
grep 📸 "$home/Application Support/Cue/sessions/"*.md; kill $pid  # then CUE_APPEARANCE=light
```

A case keeps its sandbox, PNGs included, with `node tests/e2e/run.ts --keep PREFIX`. Never commit
snapshots or put them anywhere in the repository.

The session log (`Application Support/Cue/sessions/*.md`) is the app's
progress record and what cases wait on: keep writing a line for every step a
recording goes through (`⏺ Recording started (TRIGGER)`,
`⏹ Recording stopped after M:SS (TRIGGER)` with what did it, `🎙 Transcript saved: …`, `🔊 Audio saved: …`,
`🎚 Working audio: …`, `⬆️ Uploading the recording…`, `⚠︎ The upload stopped: … — trying again`,
`⬆️ Resuming the upload of …: P of N parts are there`, `⬆️ Recording uploaded: X.X MB`, `⚠︎ Couldn't upload the recording: … — the live transcript is kept`, `🔁 Improving transcript…`, `✅ Transcript improved: …`
or `⚠︎ Couldn't improve the transcript: …`, `👥 Finding speakers…`,
`✅ Speakers: N …` or `⚠︎ Couldn't tell speakers apart: …`, `✍️ Writing summary…`,
`💡 Suggested name: LABEL → NAME`, `✏️ Renamed “OLD” to “NEW” in …`,
`🧽 Dropped a remark about the transcript from the summary: …`, `⚠︎ Summary failed: …`, `📦 Imported N notes from this Mac`, `☁️ Restored N notes from your account`,
`🔑 Signed in to Cue as EMAIL`, `🔑 Signed out of Cue` (Sign Out, or after `⚠︎ Your Cue session ended: …`),
`🔑 Cue access refreshed`, `📦 Imported N projects from this Mac (M files)`, `📎 Added FILE to PROJECT: SUMMARY`, `🗑 Removed FILE from PROJECT`,
`☁️ Saved “PROJECT” to your account`, `⚠︎ Not invited: EMAIL`, `⚠︎ Couldn't sign in to Cue: …`, `⚠︎ Sign in to Cue first`,
`📝 Notes ready: …`, `📅 Recording “Title” into Project`, `🔔 Record “Title”?`
for every notification, `⚠︎ Nothing was recorded: …` for every alert,
`🧐 Question judge ready: Claude Haiku` or
`⚠︎ Question judge unavailable (…) — going by question marks`,
`🤖 Claude: Cue plan` and `🗣 Speech recognition: Cue plan` at launch,
`⚠︎ Speech recognition unavailable: …` and
`🗣 Speech recognition ready again: Cue plan` (all three from the live call's `status` events), `📖 Waits while you read the answer in view: …`
and `📖 Shown now that you've paused: …`, `⚠︎ Couldn't start the live call: …` and `⚠︎ The live call stopped: …`
— and so on), and never rename existing lines without
updating the cases.

## Rules for changes

- Never run the app for testing without `CUE_HOME`: it would read and change
  the user's real settings, library and notes (and run migrations on them).
- Build with `apps/mac/scripts/build.sh` before running cases; the build must be
  warning-free for new code.
- Match the surrounding code: comment density, naming, SwiftUI and HIG idioms
  (standard controls, semantic colours, system Liquid Glass).
- One feature per branch and PR, with its e2e case in the same PR.

## CI and releases

- `.github/workflows/ci.yml` runs on pull requests only: it builds the app
  (new warnings in `apps/mac/Sources/Cue` fail it), runs `vp check`
  and the end-to-end suite on GitHub's hosted macOS runner with the
  latest Node. Speech needs nothing from that runner (the live transcript and the notes' second pass are the backend's, with the stand-ins), so only overlay or window
  snapshot cases skip there, with the probe's reason, if the probe finds those unreadable: CI covers the build, the
  command-line modes, the dashboard and the speech cases. **Run the
  whole suite on an authorized remote Mac before merging** and put its summary
  in the PR. Keep CI green; never fake what's missing.
- `.github/workflows/deploy.yml` runs on pushes to `main` that touch `apps/api`, `apps/admin`, `packages/contract` or their build (and on demand), never on a fork: `vp check`, the remote
  migrations, `cf deploy`, the migrations again, a check that the Worker answers. It needs the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and the variable `ADMIN_EMAILS`. Do not
  run it, or `cf deploy` without `--dry-run`, from here.
- `.github/workflows/release.yml` runs on every push to `main`: it builds
  `Cue.app`, zips it and publishes a GitHub release `v<version>.<patch>`
  (`<version>` is `CFBundleShortVersionString` in `apps/mac/Resources/Info.plist`,
  bump it for a new minor or major) with `scripts/changelog.sh` as its notes:
  every change on `main` since the previous release, one line each, with a
  merged pull request's own commits listed under it. Write commit subjects and
  pull request titles that read well in that list.
  `scripts/changelog.sh v2.0.0` prints the notes of an earlier release.
