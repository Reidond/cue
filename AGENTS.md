# Working on Cue

Cue is a macOS overlay prompter and call notetaker: SwiftPM executable in
`apps/mac/Sources/Cue`, resources in `apps/mac/Resources/`, built into
`apps/mac/build/Cue.app` by `apps/mac/scripts/build.sh`. See `README.md` for
what it does. `docs/backend.md` is the design of the Cloudflare backend and
admin app that are being added beside it. Cue for Windows (`apps/windows`, C# on
WinUI 3) is the Mac app's port: built into `apps/windows/build/ARCH/Cue.exe` and an
MSI by `apps/windows/scripts/build.ps1`; see its section below.

## Layout

The repository is a Vite+ (`vp`) pnpm monorepo:

```
package.json, pnpm-workspace.yaml   # apps/*, packages/*, tests/e2e; pnpm-lock.yaml is the only lockfile
vite.config.ts                      # the one lint (oxlint) and fmt (oxfmt) configuration, overrides per package
apps/mac/                           # the Swift app: Package.swift, Sources/Cue, Resources, scripts/build.sh
apps/windows/                       # the Windows app: Cue.slnx, Cue/ (WinUI 3), Installer/ (WiX MSI), scripts/{build,setup}.ps1
apps/api/                           # the Cue API: an Elysia Worker on Cloudflare (cloudflare.config.ts, src/, migrations/, scripts/)
apps/admin/                         # the owner's admin SPA (React): a Worker of its own (cue-admin), static assets on its own host
packages/contract/                  # TypeBox schemas of the API's requests and responses
tests/e2e/                          # the end-to-end suite, a workspace package
scripts/changelog.sh                # release notes; repo-wide, used by the release workflow
docs/                               # plan.md (the app), backend.md (the backend)
```

- Install: `pnpm install` (Node 26 or later, pnpm from `packageManager`; `vp` is
  the `vite-plus` dev dependency, run it as `pnpm vp …` or with the global `vp`), on the machine that builds: `tests/e2e/remote.ts` does it
  (see Where work runs: nothing is built or tested on this Mac).
- Check: `vp check` formats, lints and type-checks all TypeScript in one go (`vp check --fix`
  applies fixes), in Boat: `node tests/e2e/remote.ts boat check --fix`, which brings the fixes back. Run it before you commit. Never use `vp test`: unit tests are prohibited.
- Lint and format settings live only in the root `vite.config.ts`; add package
  rules as `lint.overrides` / `fmt.overrides` there, not as config files in packages.
- TypeScript is 7 (`typescript@^7`); type-aware linting runs on its native compiler (tsgo).

## The backend (`apps/api`)

Cue is a client of its own Cloudflare backend (`docs/backend.md` is the design). Signing in (Google or GitHub, invite-only) is
the only way to use the app. Build and check it in Boat (`cf build`, installs, `vp check`: `node tests/e2e/remote.ts boat …`); its cases run in a VM (see Where work runs).

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
  identity providers at a stand-in, `PUBLIC_URL` is the issuer, `ADMIN_URL` the admin SPA's origin, `ACCESS_TOKEN_SECONDS` the access token's life (900), `PORT` and
  `CUE_STATE_DIR` the dev server's port and persisted state. Nothing is deployed from here: `pnpm --filter api deploy:dry` only (`docs/deploy.md` is the owner's checklist; `.github/workflows/deploy.yml`
  deploys both Workers on pushes to `main`). The backend's production address is kept in `apps/api/production-url.txt`: the Worker's issuer (`PUBLIC_URL` outside `cf dev`) and, stamped into `Info.plist` by
  `apps/mac/scripts/build.sh`, the Mac app's default (`CUE_API_URL` overrides it); the admin's in `apps/admin/production-url.txt` (`ADMIN_URL` outside `cf dev`). In a deploy the `AI` binding is always on, `ADMIN_EMAILS` comes from the environment `cf deploy` runs in, and
  `scripts/migrate-remote.ts` applies the migrations to the deployed D1 (found by name; `--if-exists` for the run before the first deploy).
- The owner's script: `pnpm --filter api invite EMAIL` (invite), `… EMAIL --disable` (disable: banned, tokens revoked, on the KV
  denylist so access tokens stop working at once), `… --list`. It works on the local database (`pnpm --filter api migrate` first); with
  `--remote` it goes through `cf d1 raw` and `cf kv keys` to the deployed one, finding it by name (`CUE_D1_ID` / `CUE_KV_ID` name them
  when that fails). The remote path has not run against a real account yet. A user is invited or an `ADMIN_EMAILS` address
  (always invited, the `admin` role); only a provider-verified email may sign in.

## Projects and materials (`apps/api` `/v1/projects`, `apps/mac/Sources/Cue/Projects.swift`)

A person's projects and their materials live in D1 and R2; `docs/backend.md` › Materials has the design. The person adds files; everything else is written from them
(the brief) or heard (the language).

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
- **Prepared answers** written in the files are found when asked for (`src/materials/prepared.ts`, the port of `Materials.extractQA`), with every language's question and
  answer labels (`lexicon.ts`): there is no language to choose. `GET …/prepared-answers` lists them first (`from: 'materials'`), then the brief's (`from: 'cue'`), with the brief's state.
- **The brief** (`src/materials/{brief,workflow}.ts`, `prompts/brief.md`, migration `0009_project_brief.sql`): what Cue writes from a project's materials — the occasion, the names
  and terms speech recognition listens for, and answers to the 10–25 questions people are most likely to ask (Sonnet reads the files' texts, up to `BRIEF_MAX_CHARS`, and is told
  which questions the files answer already). Every file added or removed counts in `materials_version` and starts a `BriefWorkflow` (bound `BRIEF`) for it: it waits
  `BRIEF_SETTLE_SECONDS` (3) so files dropped together are read once, and only the latest version's writes. Its states: `none` (no files), `working`, `ready`, `failed` (the
  brief before stays in use, `error` says why; Claude's failure is retried). `POST /v1/projects/:id/brief` asks for it again. **`GET /v1/projects/:id/brief/events`** follows it (server-sent events,
  `routes/projects.ts`): a `brief` event (`BriefEvent`, the `Brief`) at once and whenever it changes, read from D1 every 0.5 s for a minute and every 2 s after (D1's queries per
  invocation), `ping` every 15 s, ending after the first state that isn't `working` (or when the project is gone, or after 10 minutes). The project's `occasion` and `namesAndTerms`
  are the person's own: empty means the brief's are used (`inUse` in `src/projects.ts`: the call's prompt and keyterms, the notes). Its tokens are `materials_brief` usage.
- **The language** is never set: the project's `language` is the one Cue last heard in its calls (the Call DO writes it when a call ends; `en` before). A client sending one is
  ignored.
- **The Mac app**: `ProjectStore` is the account's projects plus a folder each in the library, for the notes until PR 6. `Project.id` stays the folder name (notes and calendar
  assignments point at it); `Project.serverID`, in `project.json`, is the account's project. After sign-in (`CueAPI.onSignedIn`, before `Signed in` is logged) `syncWithAccount` lists the
  account's projects, makes a folder for the ones this Mac hasn't seen, and uploads every folder without a `serverID` once (`📦 Imported N projects from this Mac`).
  Create, rename, delete and adding or removing a file wait for the server; field edits are saved here at once and to the account after 0.8 s (`☁️ Saved “NAME” to your account`).
  `CUE_CONTROL` commands run one after another, so `new` and `add` finish before the next line. `KnowledgeBase` builds Claude's prompt from the server's text.
  After a file is added or removed (and at sync, for a brief still `working`) `followBrief` follows the brief's events (opened again when the stream drops or ends before
  the brief is written; a 404 at the first try is a server deployed before them, read every 1.5 s instead, as apps before them still do, and a 404 later is the project gone) until the brief is written: `✨ Prepared “NAME” from its
  materials: N answers, M names and terms` or `⚠︎ Couldn't prepare “NAME” from its materials: WHY`. The Overview (`ProjectView`) is the materials first, then how Cue's reading
  went (Show Answers, Try Again, Prepare), then **Advanced**, collapsed: Occasion and Names and terms, whose placeholders are the brief's. Prepared Answers has "From Your Files"
  and "Prepared by Cue".
- **AoT**: `E2E_BACKEND=preview node tests/e2e/run.ts --no-app 26 27` runs the same cases against the compiled Worker (`cf build --mode development`, `vp preview`), where Elysia compiles its routes ahead of time.
- **In a case**: `backend.call(method, path, token, { body | file })`, `backend.accountOf(email)` (`Account`: `projects()`, `materials()`, `text()`, `answers()`, `briefed(name)`: waits for
  the brief to be written or fail; `briefEvents(project)`: the brief's events, each with when it came, as `serverSentEvents` reads a stream) and
  `backend.rows(sql)` and `backend.objects()` (R2 keys) check the account from outside the app; `makeDocx`/`makePdf`/`makePptx`/`writeFile` build the files.

## Limits and usage (`apps/api/src/{pricing,limits,usage}.ts`)

What a person may spend, and what stops them. `docs/backend.md` › Limits has the design; the shapes are `Me` in `packages/contract/src/index.ts`.

- **One price table**: `PRICING` in `src/pricing.ts` (per model input / output / cache write / cache read tokens per million, Deepgram's multilingual live and recorded per minute,
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
- **In the brief Workflow**: its `limit` step asks `limitState`; over it the brief is `failed` with `Cue plan limit reached` (the one before stays in use). `POST …/brief` asks
  `mustBeWithinLimit`.
- **Rate limits**: Cloudflare Rate Limiting bindings, per user id: `RATE_LIMIT` (600 a minute, every authenticated `/v1` request, in the `authed` plugin and the socket) and
  `RATE_LIMIT_COSTLY` (30 a minute, what `mayStartCostlyWork` guards: calls and questions). Over: `rate_limited` (429, retryable). A case lowers them with `RATE_LIMIT_REQUESTS`, `RATE_LIMIT_PERIOD`
  (10 or 60) and `RATE_LIMIT_COSTLY_REQUESTS` in `cue.backend({ env })`; the limiter is eventually consistent per location in production.
- **`/v1/me`** reports `limits.monthlyUsd`, and `usage`: `usd`, `audioSeconds`, `limitReached`, `byFeature` (dearest first), `periodStart`, `periodEnd`.
- **The Mac**: `CueMe` decodes them; Settings › Account has the usage bar (`UsageBar`), the limit, when it starts over and where the money went. `AppState.planLimit` is set by
  a `limit_reached` from `POST /v1/calls`, by the socket's `error` event, or by `/v1/me` (`CUE_ME_TICK`) saying `limitReached`: an alert once (`⚠︎ Cue plan limit reached: SENTENCE`), the
  overlay's status line says "Plan limit reached", and `🔓 Cue plan has room again` when it clears (a raised limit, a new month, an answer arriving).
- **In a case** (`9d-…`, all but `9d-limit-app` and `9d-limit-overlay` run with `--no-app`): `backend.setLimit(owner, email, usd | null)` (the admin API; the backend needs
  `adminEmails`) and `backend.seedUsage` put a person over or under; `cue.backend({ env: { RATE_LIMIT_REQUESTS: '6', RATE_LIMIT_PERIOD: '10', … } })` makes `rate_limited` easy to see.

## The admin (`apps/api` `/admin/v1`, `apps/admin`: the `cue-admin` Worker)

The owner's admin: usage and money, never content (no transcripts, no notes). `docs/backend.md` › Admin API says what it covers.

- **API**: `src/routes/admin.ts`, a plugin under `/admin/v1`, authorized by a Better Auth session cookie whose user is an owner (`admin` role or
  `ADMIN_EMAILS`): no session `401`, a member `403` (`GET /admin/v1/session` alone answers a member, so the SPA can say "Not allowed";
  `DELETE /admin/v1/session` signs either out). The SPA calls it from its own origin, `ADMIN_URL`: the plugin answers that origin's CORS preflight
  (`OPTIONS /admin/v1/*`, before the session is looked up) and lets it, and no other, read the answers; a write must carry its `Origin` header.
  The two hosts are one site (`admin.cue.sands.red`, `cue.sands.red`), so the API's SameSite=Lax session cookie goes with the SPA's requests. Schemas are in `packages/contract/src/admin.ts`; money is dollars in the contract and millionths of a
  dollar in the `usage` table; times are milliseconds. Settings (default monthly limit, audio retention, pausing the plan) are rows of `setting`;
  `src/routes/v1.ts` is the `/v1` group (the plan gate, then each feature's plugin: `me`, PR 4's projects, …), and a paused plan makes every route in
  it answer `plan_paused` (503). `/v1/me` reads the limit (`user_limit`, else the default) and the month's usage from `usage` (see Limits and usage).
- **One code path for who may use Cue**: `src/accounts.ts` holds the SQL of invite, enable, disable and revoke (plain TypeScript, no
  `cloudflare:workers`); the admin API runs it through `env.DB.batch`, the owner's script (`scripts/invite.ts`) through `cf d1 raw`. Disabling also
  puts the user on the KV denylist (`denylistKey`).
- **The SPA** (`apps/admin`: React 19 with the React Compiler, TanStack Router file routes and Query, Eden typed from the api's `App`, Base UI, plain
  CSS tokens in `src/styles/tokens.css`) is a Worker of its own, `cue-admin` (`apps/admin/cloudflare.config.ts`): no code, Vite's client build as static
  assets with the SPA fallback, at the root of its own host (`apps/admin/production-url.txt`, `https://admin.cue.sands.red`), deployed after the API.
  `apps/admin/vite.config.ts` stamps the API's origin in (`import.meta.env.CUE_API_URL`: `CUE_API_URL`, else `apps/api/production-url.txt` in a build
  and `http://127.0.0.1:5173` under `cf dev`, whose own port is `PORT`, 5174 by default); Eden sends the cookie (`credentials: 'include'`).
  `pnpm --filter admin dev` beside `pnpm --filter api dev` is the pair. `src/routeTree.gen.ts` is generated (by `cf dev` or `cf build`) and committed.
  Signing in is the API's `/login/PROVIDER?next=admin` (Better Auth trusts `ADMIN_URL`'s origin), which comes back to the admin's `/`.
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
  `answer.delta|done`, `error`, `language`, `ended`, each with a `seq`; the last 1000 are kept, and `after=SEQ` replays what a reconnecting client missed. A call with no client for
  `CALL_GRACE_SECONDS` (120) ends by itself. The reading rules (`show`, `newest`, holding the view) stay on the Mac: they are UI.
- **The language is heard**: both streams are Nova-3's multilingual model (`language=multi`, `SPOKEN`), which says what each word is in. The call's language is the
  one most words of the last 8 lines were in (it starts as the project's `language`, the last one heard); when it changes the `language` event says so (and is sent to a client
  connecting afresh), the call row keeps it (`call.language`, for the notes) and the project gets it when the call ends. The system prompts name no language (so the cache
  holds): each question's message says what to answer in and its two labels (`Numbers` / `Source`, `Цифри` / `Джерело`); the opener is that language's; matching and
  echoes use every language's stop words. The Mac logs `🌐 Language heard: NAME` and follows it in the overlay's labels and the note it writes.
- **Two languages** (`src/languages.ts`, `preference` table, migration `0010_languages.sql`): a person reads Cue in up to two languages (`LANGUAGES` in the contract;
  `PUT /v1/me/languages`, `Me.languages`; a running call takes them in `config`). With two, `pairFor` says what to answer in (the heard language when it is one of
  them, else the first) and what to translate into: each question's message asks Claude to follow every line with its translation on a `» ` line, the judge's
  message asks for a `T: ` line after each `Q: ` (kept by question text), and the `question` event carries `translation` `{language, name, text}`. The apps
  show it in the layout the person picked (Settings › General › Languages: Subtitles, Side by side, Focus). On the Mac (`Languages.swift`: `CueLanguage`, `AnswerLayout`, `NoteLayout`; `OverlayView`) an answer is rows, a `» ` line the translation of the row above;
  Side by side needs 560 pt (narrower it is Subtitles; choosing it widens a narrow overlay to 680). The notes' file holds the translation as a
  `<!-- cue:translation CODE -->` block after the summary and a `> ` line under each turn (`NoteMarkdown`, read back by `MarkdownView`; import drops both); the note page has the
  language switch (Switch between them) or both in turn (One after another), and a Translations switch by the transcript's heading.
- **The Durable Object** (`call.ts`) wires: `deepgram.ts` (a live stream per channel, Nova-3 multilingual, `diarize` on `others`, endpointing 700 ms, KeepAlive, reopened when it
  drops), `detector.ts` / `judge.ts` (ports of `QuestionDetector` / `QuestionJudge`: the waiting rules, Haiku with `prompts/judge.md`), `knowledge.ts` (the system
  prompt from `prompts/prompt.md`, the project's prepared answers (the files' own and the brief's) and materials; `Matcher` is `KnowledgeBase.match`), `session.ts` (a Claude conversation:
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
  when the call goes on), makes the `note` row and starts **`NotesWorkflow`** (`src/notes/workflow.ts`, bound `NOTES`). The note is worded in the call's language (`call.language`,
  else what the client heard, else the project's last). Steps `transcript` (Deepgram recorded-file API, Nova-3 multilingual: the language most of the recording's words are in
  becomes the note's, `tag=me|others`, `diarize` on the call side, keyterms from the project; echo and `sideLost` rules ported from the app) → `speakers` (the port of `Speakers.label` on the words'
  voices) → `names` (Sonnet, `prompts/names.md`) → `summary` (Sonnet, `prompts/summary.md`; remarks about the transcript dropped, title taken) → `store`. Each step is retried
  three times (`NOTES_RETRY_SECONDS` apart); one that fails for good is marked failed and the next runs: the note keeps what it had. Only the note id goes between steps; the working
  transcript is in D1 (`note.lines`, `note.voices`, `note.transcript`).
- **Progress**: every step writes `note_event` rows whose `line` is the session-log line (`🔁 Improving transcript…`, `✅ Transcript improved: N segments (X s for M:SS of audio)`,
  `⚠︎ Couldn't improve the transcript: WHY — the live transcript is kept`, `👥 …`, `✍️ …`, `💡 Suggested name: …`); `GET /v1/notes/:id/events` streams them as SSE (an Elysia generator route,
  `Last-Event-ID`/`?after`, `ping` heartbeats, ends after the `note` event) and `steps` on `GET /v1/notes/:id` is the page's list. A Workflow that dies is noticed by the stream and the note is
  made ready with a `note: failed` event.
- **Translation**: with two languages chosen the last step, `translate` (`src/notes/translate.ts`, `prompts/translate.md`, Haiku), writes `note.translation`
  `{language, name, title, summary, transcript}`: the title (always) and the summary in one request, the transcript in batches of numbered lines bounded by `TRANSLATE_BATCH` lines and
  `TRANSLATE_BATCH_CHARS` characters, a long turn in pieces cut between sentences (one string per turn); a reply cut off (`max_tokens`) or missing lines is tried again.
  Lines `🌐 Translating notes…`, `✅ Notes translated into NAME: N lines`, `⚠︎ Couldn't translate the notes: WHY`; its tokens are `note_translation`. A rename reaches it.
- **Editing**: `PATCH` renames a speaker throughout the note (whole words: transcript, summary, title, participants), applies or dismisses a suggestion; `DELETE` trashes (audio deleted at once);
  `GET …/audio/:side` serves R2 with range requests. `POST /v1/notes/import` and `PUT /v1/notes/:id/audio/mixed` bring in a note the Mac had before it had an account.
- **Retention**: the `Janitor` Durable Object (`src/notes/janitor.ts`, bound `JANITOR`, one instance, an alarm) deletes audio `audioRetentionDays` after a note was ready (Keep audio off: when
  the notes are ready) and aborts abandoned uploads. `RETENTION_DAY_SECONDS` (86400) and `RETENTION_TICK_SECONDS` (3600) shorten it in a case.
- **The Mac**: `save` writes the live-transcript note exactly as before, then `RecordingStore.process` uploads (`RecordingUploader`: parts of `CUE_UPLOAD_PART_BYTES`, retries, resume;
  `CUE_UPLOAD_BREAK=n` cuts the connection once), starts the notes (with a call just for them when none is live), follows the events — each `line` goes to the session log verbatim —
  and when the note is ready writes the server's note into the Markdown copy in `Documents` (front matter `note: ID`). `RecordingStore` still reads the library's files; after sign-in
  `syncWithAccount` imports notes without a `note:` (`📦 Imported N notes from this Mac`) and writes the account's notes the library lacks (`☁️ Restored N notes from your account`).
  Rename, Apply, ✕ and Move to Trash are `PATCH` / `DELETE` and then the same file edits as before; the player streams `…/audio/mixed` when the `.m4a` isn't on disk.

## Cue for Windows (`apps/windows`)

The port of the Mac app to WinUI 3 (C#, .NET 10 LTS, Windows App SDK 2), in slices: the foundation (the shell, storage, session log, test hooks, sign-in
and account, installer, CI and the e2e harness on Windows), then projects and materials, the live call and its overlay, recordings and notes, meetings and
the calendar, each plugging into the pieces below. Fluent idioms are the HIG rule here: `NavigationView`, `TitleBar`, Mica, light and dark by the system,
standard controls, `Segoe Fluent Icons`, theme resources; no embedded WebView (the system browser signs in).

- **Layout**: `Cue.slnx`, `Cue/` (the app: `Core/` has no UI, `Views/` the pages, `MainWindow`), `Installer/` (WiX), `scripts/{build,setup}.ps1`.
  The app is unpackaged (`WindowsPackageType=None`) and self-contained (`SelfContained`, `WindowsAppSDKSelfContained`): `Cue.exe` and the .NET and
  Windows App SDK runtimes sit in one folder, so the MSI needs no runtime installer. x64 and arm64; Windows 11 and Windows 10 22H2 (`TargetPlatformMinVersion` 10.0.19041).
- **Build**: `powershell -ExecutionPolicy Bypass -File apps\windows\scripts\build.ps1 [-Arch x64|arm64] [-Version 2.0.1] [-Msi [-Quick]] [-Output DIR]` is the one
  entry point (you, the suite, CI, release): it publishes to `apps\windows\build\ARCH\Cue.exe` and with `-Msi` makes `build\Cue-VERSION-ARCH.msi` (`dotnet
  build` of `Installer\Installer.wixproj`, WiX `WixToolset.Sdk` 6.0.2: no Visual Studio). Warnings fail it (`TreatWarningsAsErrors`; the installer's ICE rules
  it ignores on purpose are named in the wixproj; `-Quick` makes an installer only a case installs, files stored and no validation: 6 s, not 55). The version is the Mac's, `CFBundleShortVersionString` of `apps/mac/Resources/Info.plist` plus the patch
  (`-Version`, which release.yml computes from the tags), and goes into both the app (`Env.Version`, `Cue-Version: windows/VERSION`) and the MSI; the
  backend's address is stamped from `apps/api/production-url.txt` (assembly metadata `CueApiUrl`; `CUE_API_URL` overrides it; a plain `dotnet build`
  talks to `cf dev`). WiX 7 makes its user accept the OSMF EULA (`AcceptEula`: a fee above $10k revenue a year): that is the owner's call, so
  the repository stays on 6.0.2. `scripts/setup.ps1 [-Install] [-Backend]` installs the toolchain on a fresh Windows (git, .NET 10 SDK, Node.js 26, pnpm; `-Install` runs
  `pnpm install`; `-Backend` leaves out the SDK and OCR for the backend's cases); on Windows for Arm Node.js is the x64 build on purpose and the x64 Visual C++ runtime is added, as workerd and Vite+'s native
  packages exist for x64 only and run emulated.
- **The MSI** (`Installer/Package.wxs`): per machine into `Program Files\Cue`, a Start menu shortcut, an entry in Apps, a stable `UpgradeCode` with `MajorUpgrade` (a newer
  MSI replaces an older one, an older one is refused), nothing in the registry; the person's settings, library and notes stay on uninstall. It is unsigned: the release notes
  say what SmartScreen shows. The URL protocol the Mac needs is not needed (below).
- **Sign-in** (`Core/CueApi.cs`, `Core/LoopbackReceiver.cs`): the Mac's OAuth 2.1 + PKCE flow as its own trusted client `cue-windows` (`migrations/0008_windows_client.sql`,
  `OAUTH.windowsClientId`), through the system browser and a **loopback redirect** (RFC 8252 §7.3): Cue listens on `127.0.0.1` at a port the system gives it and sends
  `http://127.0.0.1:PORT/oauth/callback`; the client is registered as `http://127.0.0.1/oauth/callback` and Better Auth's oauth-provider accepts any port for it (and nothing
  else). Chosen over a registered URI scheme with `AppInstance` redirection because it needs nothing registered (not by the MSI, not by a dev build), no second process
  to hand the callback over, no browser "Open Cue?" prompt, and the case runs the real listener. The pages a failed sign-in ends at (`/invite-only`, `/sign-in-failed`) send the
  person back to the app that started it: `/login/:provider` leaves a `cue_return` cookie with the authorization request's redirect URI (the Mac's scheme, or a loopback address with a
  port), and `src/pages.ts` builds "Return to Cue" from it (the Mac's when there is none). The refresh token is in Windows Credential Manager (`Core/SecretStore.cs`); under
  `CUE_HOME` in `CUE_HOME/Keychain.json` as on the Mac. `CUE_WEB_AUTH=headless` follows the authorize URL with `HttpClient` and cookies, presses the stand-in provider's
  button, and ends where a browser would, at Cue's own listener.
- **Projects and materials** (`Core/{Projects,ProjectStore,ProjectsApi,ProjectCommands,Shell}.cs`, `Views/{ProjectPage,ProjectOverviewView,PreparedAnswersView,ProjectDialogs}`): the port of the Mac's
  `ProjectStore`, `Project` and `ProjectView`, with the same behaviour (see "Projects and materials" above: the account holds them, `Documents\Cue\NAME\project.json` with `serverID` and a `Notes\` folder is the
  library). `AppState.Projects` is **the one place the rest of the app finds the projects**: `Projects` (sorted as Explorer sorts names), `Find(id)`, `FindByName(name)` (name or folder, as `CUE_PROJECT` and the hooks
  take it), `MostRecent`, `Active` (the project Cue answers from and records into: the folder name kept in `settings.json` as `activeProject`, chosen after sign-in by `ChooseActive`: `CUE_PROJECT`, else the last one,
  else the most recently used; `📁 Project: NAME`), `Activate(project)` (stamps `LastUsed`, saves it to the account, logs `📁 Project: NAME` when it changed), `Project.ServerId` (what a call is made for) and
  `Project.Materials`. After sign-in (`CueApi.OnSignedIn`, before `Signed in` is logged) `SyncWithAccount` lists the account's projects, makes a folder for those this PC hasn't seen and uploads every folder
  without a `serverID` once with its `Materials\` files (`📦 Imported N projects from this PC (M files)`: **"this PC", not "this Mac"**, the one log line the Windows app words differently). Create, rename, delete and
  adding or removing a file wait for the server; field edits are saved to `project.json` at once and to the account after 0.8 s (`☁️ Saved “NAME” to your account`). A deleted project's folder goes to the Recycle Bin
  (`Shell.MoveToRecycleBin`). The dashboard: `DashboardPage.Project` with `Dashboard.ProjectId` and `Dashboard.Section` (`ProjectTab`: Overview, Answers, Notes; the notes slice filled `ProjectPage`'s Notes tab (`NotesView`) and
  Home's recent notes); `Dashboard.OpenProject(id, tab)`; the pane (`MainWindow.RefreshProjects`) has a "Projects" header, an item per project with a context menu (Rename…, Show in Explorer, Move to
  Recycle Bin…) and New Project (Ctrl+N) below; the start-Cue button belongs in `ProjectPage`'s header (the live-call slice). The prepared answers and the token estimate on a page come from `ProjectStore.Documents`
  (`KnowledgeBase`, as the Mac's); the account's server builds the prompt.
- **Where the next slices plug in**: `AppState` (`Core/AppState.cs`: the log, preferences, `Api`, `Projects`, `Dashboard`, `Control`, `PlanLimit`; one instance, `App.State`); `CueApi.Request(method, path, query, json,
  file, body, contentType, timeout)` and `Bearer()` for every call (a bearer token refreshed on its own, `{error: {code, message, retryable}}` as `CueApiException`: kinds
  `LimitReached`, `RateLimited`, `PlanPaused`, `Ended`, `Network`, `Server`; `OnSignedIn` runs before Cue counts as signed in); `state.Control.Register("new", run, needsSignIn)` for a `CUE_CONTROL`
  command; `DashboardModel.PageResolvers` for `page NAME` and `DashboardPage` + `MainWindow` for navigation items (a page is a `Page` that gets the `AppState` as its navigation parameter,
  and shows a `SignInView` while signed out); `Settings` tabs in `SettingsPage`; `SessionLog.Write` (use `SessionLog.Warning` for `⚠︎`, whose second character is U+FE0E); `Storage.AppSupport` and
  `Storage.Documents` for paths (**keep every `DispatcherQueueTimer` in a field**: one that only a local variable holds is garbage-collected and silently stops, which looked like commands and snapshots going missing now and then; and **set a host's `Child` only when it changes, and ignore an `Unloaded` while `IsLoaded`**:
  an element set again is taken out and put back, and WinUI may tell it Unloaded after the Loaded of its return, which left the Notes page deaf to the note being made); `SettingsFile`/`Preferences` for settings (`settings.json`).
- **Where it is built and tested**: never on this Mac. In the Cue Windows VM (VMPal's, Windows 11 for Arm: see Where work runs), through `tests/e2e/remote.ts`:
  `node tests/e2e/remote.ts windows e2e w --except=w1- 9e-`. Never build on a VMPal shared folder (`Z:`): `remote.ts` copies the checkout to `C:\cue\ID`.
  `w1-installer` installs per machine, so it needs an elevated process (`remote.ts windows --admin e2e w1-`, `vmpal_exec_admin`) and skips without.
- **Cases**: `w0-…` (the app: sign-in, not invited, sign out, account and limit, hooks), `w1-…` (the installer), `w2-…` (projects and materials: `w2-projects`, `w2-materials`, `w2-import-projects`,
  `w2-account-projects`, `w2-active-project`, `w2-brief` (the Overview: Materials, how Cue read them, the Advanced `Expander`; Try Again); they read the window with `windowText`, open an `Expander` with `expand(pid, name)` (UI Automation's expand pattern: its header is no button to `press`), the account with `backend.accountOf(cue.email)`), `w3-…` (the live call: see Live call on Windows), `w4-…` (recordings and notes: see Recordings and notes on Windows) and `w6-…` (meetings, the calendar and notifications: see Meetings, the calendar and notifications on Windows) are Windows-only: the Mac's `run.ts` skips every `w…` case, Windows' runs
  them together with the cases that never launch the app (the source has no `.launch(`, `.cli(` or `.control(`: the backend's own, `9a-…` to `9f-…`, `95`–`99`). `9e-windows-sign-in` signs in as `cue-windows` end to end
  and runs anywhere with `--no-app`. Every later `wN-…` case is the app's too. A case reads what the window shows with `windowText(pid)` (`tools/uia.ps1`: the text of its UI Automation tree, exact (no recognition errors); a XAML `ScrollViewer`'s content scrolled out of view is not in it),
  and `windowsOf(pid)` is `tools/windows.ps1` (the foreground, the windows' sizes and styles: the twin of `appWindows`); `ocr` is `tools/ocr.ps1` (Windows' own `Windows.Media.Ocr`; it needs the English recognizer,
  `Language.OCR~~~en-US~0.0.1.0`, which `setup.ps1` adds) for what a snapshot shows; `cue.defaults()` edits `settings.json`; `cue.stop()` sends `quit` through the control file and kills the tree after 10 s.
- **Hooks that differ** (the rest of the table below applies as it reads; `CUE_REHEARSE_PARTICIPANT` / `CUE_REHEARSE_ME` play a WAV, `CUE_NO_LIVE_AUDIO` and `CUE_ALLOW_CAPTURE` as on the Mac; `CUE_REHEARSE_RECORD=1` records the rehearsal into notes, `CUE_UPLOAD_PART_BYTES` / `CUE_UPLOAD_BREAK` as on the Mac): `CUE_HOME` has the Mac's layout (`CUE_HOME/Application Support/Cue`, `CUE_HOME/Documents`, sessions in
  `Application Support/Cue/sessions/*.md`) and keeps settings in `Application Support/Cue/settings.json`, the refresh token in `CUE_HOME/Keychain.json` (without it: `%APPDATA%\Cue`, `Documents\Cue`, Credential Manager);
  `CUE_LOCALE=en-US` makes numbers, dates and Windows' own strings that culture (the harness sets it: the Mac's `-AppleLocale`); `CUE_BACKGROUND=1` shows the window without activating it, as a tool window (no taskbar button) that a
  click doesn't activate, at the bottom of the z-order, with the process opted out of power throttling, and an alert goes only to the session log; `CUE_SNAPSHOT=png` writes `…-dashboard.png` every 2 s with `PrintWindow`
  (Settings is a page of the dashboard, so there is no `-settings.png`; `CUE_SNAPSHOT_METHOD=xaml`, only here, draws each window with XAML itself (`RenderTargetBitmap`) over its material's solid fallback, for when PrintWindow's capture of a background window comes out garbled — no Mica or acrylic, no caption buttons; the Mac's methods don't apply; `📸 Snapshots: window capture (PrintWindow), in the dark appearance`); `CUE_APPEARANCE`, `CUE_SHOW_SETTINGS`,
  `CUE_ME_TICK`, `CUE_API_URL`, `CUE_WEB_AUTH=headless`, `CUE_PROJECT=name` as on the Mac; `CUE_CONTROL` commands now: `signin [google|github]`, `signout`, `settings general|account|calendar`,
  `page home|upcoming|NAME|NAME/overview|NAME/answers|NAME/notes`, `size W H`, `quit`, and the projects': `new NAME`, `add PATH` (a file dropped on the open project's materials, else the active project's),
  `set PROJECT | occasion|names | VALUE`, `remove PROJECT | FILE`, plus two the Mac has no command for, because it does them in a dialog no case drives: `rename-project NAME | NEW` and `delete-project NAME`
  (what the pane's context menu runs), and `update check|restart` as on the Mac. Commands run one after another, so `new` and `add` finish before the next line. `signin`, `signout`, `settings`, `page`, `size`, `update` and `quit` work signed out; any other command then
  logs `⚠︎ Sign in to Cue first (NAME ignored)`.
  The live call's `CUE_CONTROL` commands: `start NAME` (Start Cue for that project: shows the overlay and listens), `stop`, `project NAME` (the overlay's project menu), `ask TEXT`, `show TEXT`, `newest`, `prepare`; the project is found as `page NAME` finds it (by name, else by folder name), and none is no-op, as on the Mac.
  The meetings' `CUE_CONTROL` commands: `assign EVENT | PROJECT` (the project picker of an event on Upcoming, by the event's title) and `notification record|dismiss` (Record / Not Now on the latest prompt); `CUE_CALENDAR_EVENTS`, `CUE_MIC_APPS`, `CUE_MEETING_TICK` and `CUE_MIC_RELEASE` are as on the Mac except that `CUE_MIC_APPS` names program files or package family names, not bundle IDs, and that without `CUE_CALENDAR_EVENTS` the calendar is Windows' appointment store (see Meetings, the calendar and notifications on Windows).
  `CUE_SURFACES=1`, only here: under `CUE_BACKGROUND` the live call's surfaces — the overlay, the tray icon, the hot keys — are as in normal use (the overlay above other windows, the keys registered); without it a test run has no tray icon or hot keys (as the Mac) and the overlay stays at the bottom.
  `CUE_LIVE_BREAK=SECONDS` (only here) loses the live socket once, that long after it first came up: the call reconnects (`⚠︎ The live call's connection: …`) and goes on over the same call.
  `CUE_SNAPSHOT` also takes the overlay (`PrintWindow`, to the file itself, `…cue.png`; the dashboard's is `…-dashboard.png`) and, like `CUE_ALLOW_CAPTURE=1`, lets screenshots see it.

## Live call on Windows (`apps/windows/Cue`: `Core/{LiveModel,LiveCall,AudioSink,AudioCapture,Wasapi,Rehearsal,…}.cs`, `Views/OverlayWindow.cs`)

The port of `LiveCall`, `AudioCapture`, `OverlayView`, `HotKeys` and the call half of the Mac's `AppState`, on the foundation above. Session log lines, the reading rules and the exchange and answer state
are the Mac's, word for word.

- **The call model** (`Core/LiveModel.cs`, `state.Live`): between Start Cue and Stop Cue it opens the audio, makes a call (`POST /v1/calls`), and drives `Exchange`s and `Answer`s (`Core/Calls.cs`) from the events: show,
  newest, holding the view while an older answer is read, `Unseen`, the 5 s reading pause, Prepare Answer, Auto, the plan limit (`AppState.ReachedLimit` / `ClearPlanLimit`). `LiveModel.Changed` says the lists changed
  (the overlay and Home redraw), `Samples` is where **both sides' audio** passes (`Action<Side, float[], double>`: 16 kHz mono floats and the host time (`Audio.HostSeconds`, the QPC clock) of the first sample, from the capture threads,
  the rehearsal's too): `AudioRecorder` subscribes there to write the two sides to files (Recordings and notes on Windows below), the record button is in `OverlayWindow.RecordSlot`, the menu items in `Core/Tray.cs`, `Tray.Recording` (red icon)
  and the hot key (Win+Alt+C, in `Core/LiveSurfaces.cs`; not R, which is the Game Bar's) follow the recorder, and `UpdateCapture` keeps the audio and the call open "while a recording is under way".
- **The socket** (`Core/LiveCall.cs`): `System.Net.WebSockets.ClientWebSocket`, one writer queue (the capture threads send audio, the UI thread commands: a socket sends one message at a time), reconnects with the Mac's backoff
  (0.5, 1, 2, 5 s) and `after=SEQ`, `404` ends the call, `401` refreshes the token. The Ask field and Answer now are socket commands (`ask`, `answerNow`), as on the Mac, not `POST /v1/calls/:id/questions`.
- **Audio** (`Core/Wasapi.cs`, `Core/AudioCapture.cs`, `Core/AudioSink.cs`): WASAPI by direct COM interop, no NAudio: process loopback (`ActivateAudioInterfaceAsync` with `VAD\Process_Loopback`, **excluding Cue's own process tree**;
  Windows 11, Windows 10 build 20348+) is not in NAudio, and one hand-written path serves the microphone (default capture device), the call (process loopback, falling back to the default speakers' loopback with
  `🔊 Call audio: the default speakers, Cue's own sound included (WHY)`), both shared-mode, event-driven, asked for 16 kHz mono 16-bit from the audio engine (`AUTOCONVERTPCM`; 48 kHz stereo and `Resampler` where it will not).
  `AudioSink` is `AudioSink.swift`: frames are one channel byte (0 me, 1 others) and PCM16 LE, contiguous, 100 ms at least; silence is filled by the host clock (a loopback stream delivers nothing while the PC is silent) and so is
  what a dropped socket lost (20 s at most); a really open source's lane starts with the call (`Expect`), so a silent call side keeps its clock. The VM has speakers and no microphone: the microphone's status line says so
  ("No microphone found") and its code is **not exercised** by any case; `w3-call-audio` plays a WAV through the speakers and hears it through process loopback (skips without a sound device: a CI runner has none).
- **The overlay** (`Views/OverlayWindow.cs`): a code-built WinUI `Window`, **designed as a Windows 11 app, not as a copy of the Mac's glass panels** (the behaviour is the Mac's: what it shows, the reading rules,
  `CUE_CONTROL`, the log lines). *Window*: borderless (`OverlappedPresenter.SetBorderAndTitleBar(true, false)`, resizable, 400 × 360 at least), Windows 11's rounded corners (`DWMWA_WINDOW_CORNER_PREFERENCE`), `WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE`
  (no taskbar button, a click never activates it), always on top, `AppWindow.Show(false)`, `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` (hidden from captures and screen sharing; `WDA_MONITOR`, black, where Windows has no better;
  `CUE_ALLOW_CAPTURE` / `CUE_SNAPSHOT` turn it off). *Material*: `ActiveAcrylicBackdrop`, the Fluent desktop acrylic of Windows 11's flyouts that stays acrylic though the window is never active (the stock one falls back to a flat colour when
  its window is inactive); with transparency effects off, or in high contrast, the controller paints the system's solid fallback. *Controls*: a `CommandBar` (the title area, which drags the window) with the project's `DropDownButton`, the status
  (`ProgressRing`, check or warning glyph, text) and `AppBarToggleButton`s (Auto, Transcript) and a Settings `AppBarButton` (all on the bar's middle line: a `CommandBar` puts its content at the top unless told; a command without a label is 40 px square, not the default 68; the status ends in "…" with a tooltip rather than being cut off, and Auto's label folds away while the status needs its room: `Fit`); an `InfoBar` for what needs attention (the plan's limit, no project, no materials, no audio) with *Open Dashboard*, and inside
  an answer ("Doesn't sound like a question for you" with *Answer Anyway*; an answer's error); cards (`CardBackgroundFillColorDefaultBrush`, `CardStrokeColorDefaultBrush`) for the answer in view and the New and Answered lists, whose rows are
  subtle buttons (hover, press and focus as the system's lists); an `Expander` for the prepared answer; a `TextBox` and an accent *Answer now* button for Ask; the *1 New Question* button floats over the list on a `ThemeShadow`. *Text and icons*: the
  Fluent type ramp (`TitleTextBlockStyle` for what to say, `BodyStrong` for the questions, `Body`, `Caption` for the groups, in Segoe UI Variable), at sizes that follow the person's text-size setting (Win+Alt+ + / -); Segoe Fluent Icons glyphs.
  *Colour and shape*: only theme resources (text, card, subtle fill, accent, system fill brushes: the system accent colour, light, dark and high contrast), `ControlCornerRadius` (4) and `OverlayCornerRadius` (8), spacing in multiples of 4.
  A change of the theme or of the system's colours (`ActualThemeChanged`, `UISettings.ColorValuesChanged`: light, dark, high contrast, the accent) re-takes the brushes of the few plates built once and redraws the lists (rebuilding the whole tree fails: the record slot would have two parents). Every control has its UI Automation name (the cases read them). **Typing into Ask** is the one time it takes the keyboard:
  the pointer press or focus on the box removes `WS_EX_NOACTIVATE`, `SetForegroundWindow`s the overlay and remembers the window it came from; Enter, Escape or losing the focus puts the style back and gives the focus back. Its position is kept in
  `settings.json` (`overlayBounds`; not under `CUE_HOME`). The lists are redrawn (at most every 100 ms) from `LiveModel`; a case reads them with `windowText(pid)`.
- **Hot keys** (`Core/HotKeys.cs`, `Core/LiveSurfaces.cs`): `RegisterHotKey` on a message-only window (`Core/NativeShell.cs`). **Win+Alt+KEY, not the Mac's Ctrl+Alt**, which is AltGr on many layouts (Polish, German, Ukrainian…) and would swallow typed
  characters: Enter answer now, H show/hide (starts Cue when it doesn't run), A Auto, Page Up / Page Down previous / next answer, + / - text size. Windows keeps Win+Alt with the arrows (they failed to register) and the Game Bar has
  Win+Alt+R. One another program holds is logged (`⚠︎ Couldn't register the shortcut for NAME: another program uses Win+Alt+KEY`) and skipped. None under `CUE_BACKGROUND` unless `CUE_SURFACES=1`.
- **The tray icon** (`Core/Tray.cs`): `Shell_NotifyIconW` and a native popup menu (Start/Stop Cue, Show or Hide, Answer Now, Open Dashboard, Settings, Restart Live Call, Quit); with it, closing the dashboard only hides it.
- **Starting, and the projects**: the live call follows the projects' store (`state.Projects`, the projects slice above): `LiveModel.ActiveProject` is `ProjectStore.Active`, chosen at sign-in (`CUE_PROJECT`, else the last used) or by the person
  (the overlay's project drop-down lists `state.Projects.Projects`; `ProjectStore.Activate` marks it used and logs `📁 Project: NAME`). **Start Cue is on a project's page** (`Views/ProjectPage`: *Start Cue* / *Stop Cue* beside its name), and Ctrl+Enter anywhere in the
  dashboard is the Mac's File › Start Cue (`LiveModel.ToggleCue(open)`: Stop Cue while it runs for the project open, or none; else Start Cue for the open project, else the active one; none at all, the dashboard). A call is made for the project's `ServerId`:
  one that has not reached the account yet shows "Waiting for the project to reach your account" and the call starts once it has, and another project (or its materials arriving) changes the status line and the call (`LiveModel.ProjectChanged`).
  `start NAME` / `project NAME` find the project as `page NAME` does (`ProjectStore.FindByName`: by name, else by folder name), and none is a no-op, as on the Mac.
- **Two languages** (`Core/Languages.cs`, `Core/Preferences.Languages.cs`, `Views/GeneralView.cs`, `OverlayWindow`, `NotesView`, `MarkdownView`, `NoteMarkdown`): the Mac's, word for word and in the same file
  format — the pickers (the account's languages), `answerLayout` and `noteLayout` in `settings.json`, the three overlay layouts (Side by side widens a narrow overlay to 680 epx
  when chosen, keeping its right edge, and is Subtitles under 560), the two note layouts and the Translations switch, and the commands `languages`, `answer-layout`,
  `note-layout`, `note-language`. Cases `w0-languages` (the pickers and the account), `w3-two-languages` (every overlay layout, the narrow fallback, one language) and
  `w4-two-languages` (the file's block and `> ` lines, both note layouts, a rename, an import).
- **Cases** `w3-…`: `rehearsal` (transcript, question, prepared match, streamed answer on the overlay, and in the snapshot), `reconnect` (the socket lost with `CUE_LIVE_BREAK`: the same call goes on, nothing shown twice), `ask` (Prepare Answer, Ask, Answer now), `language` (a Ukrainian rehearsal: `🌐 Language heard: Ukrainian`, the overlay taking that language's labels), `reading` and `reading-aloud` (show, newest, the
  New question button, the reading rules), `limit`, `deepgram-drops`, `overlay-bar` (at the default size, while recording: one middle line, nothing overlapping, the whole status in the snapshot), `overlay` (above another program's window, never the focus, a real click and real typing, hidden from `CopyFromScreen`, shown with `CUE_ALLOW_CAPTURE`),
  `hot-keys` (real key presses), `call-audio` (real loopback). They use `bursts` and the stand-ins' lines (`FAKE_DEEPGRAM_LIVE`), `accountProject(cue, name, { materials })` (a project in the case user's account, made
  through the API), `press(pid, name)` (UI Automation invoke: `tools/uia-click.ps1`), `click(pid, name)` (a real mouse click at the control), `typeText`, `pressKeys('win', 'alt', 'h')` (`tools/keys.ps1`, `SendInput`),
  `captureScreen(rect, png)` (`tools/capture.ps1`: what a screenshot sees), `controlsOf(pid, title)` (`tools/uia-bounds.ps1`: the named controls of a window and where they are), `needInteractiveDesktop()` (skips `overlay` and `hot-keys` where a window shown never gets the keyboard focus and injected keys go nowhere: it showed on the `windows-11-arm` runner, where they failed; the x64 runner and the VM have one), `needAudioOutput()`, `windowsOf` now also has `topmost`, `affinity`, `left` and `top`, and `tools/blocker.ps1` is the other program's window.

## Recordings and notes on Windows (`apps/windows/Cue`: `Core/{LiveModel.Recording,Recordings,RecordingStore,AudioRecorder,NotesApi,NoteMarkdown,NotePlayer,RecordingCommands}.cs`, `Views/{NotesView,MarkdownView,RecordControl}.cs`)

The port of `Recordings.swift`, `NotesAPI.swift`, `NoteMarkdown.swift` and the recording half of the Mac's `AppState`, on the live call above. The behaviour, the session-log lines (see the list in Test hooks in the app: `⏺ Recording started (TRIGGER)` …
`📝 Notes ready`) and the `CUE_CONTROL` commands are the Mac's; the notes themselves are the backend's (Notes above).

- **Recording** (`LiveModel.Recording.cs`): `StartRecording(trigger)` / `StartRecording(project, meeting, trigger)` (the calendar slice passes the event as `MeetingDetails`), `StopRecording(trigger, automatically, saved)` (`saved` gets the
  note's id, null when nothing was heard), `ToggleRecording(trigger)`; `Recorder` (`CallRecorder`: `StartedAt`, `Stopping`, `IsRecording`; observable) collects the live call's `Utterance`s. Recording opens the audio and the live call as Cue does, Cue running or not
  (a call made with `questions` false). Stop waits 2.5 s for the last phrase, then `RecordingStore.Save`. `RecordingTrigger` is what the log names: `Win+Alt+C`, `overlay`, `dashboard`, `notification area`, `Upcoming`, `Record in the notification`,
  `call noticed`, `call ended`, `rehearsal`. A recording nobody spoke in is `⚠︎ Nothing was recorded: …` and no note. `CUE_REHEARSE_RECORD=1` records the rehearsal from `Rehearse` and stops it a second after the audio ends.
- **Audio** (`AudioRecorder`): a worker thread fed from `LiveModel.Samples`; each side is placed by its capture time (a gap is silence), so the files are as long as the recording: `Application Support\Cue\recordings\STAMP\{mic,call}.wav` (16-bit 16 kHz mono) and
  `mixed.wav`, which `Finish` encodes to `mixed.m4a` (AAC) with `Windows.Media.Transcoding.MediaTranscoder`, Windows' own encoder, no package. With Keep audio (Settings › General › Notes) the m4a is moved next to the note; the working folder goes once the notes are ready
  (`🧹 Working audio removed`), and ones older than a week at launch.
- **The store** (`RecordingStore`, `state.Recordings`): the notes are Markdown files in each project's `Notes` folder (`2026-10-24 14.05 – TITLE.md`, local time, what Windows forbids in a name replaced by `-`), `RecordingFile.Id` is `PROJECT/STAMP` (stable when the title
  changes). `Save` writes the live transcript note and its audio at once, then `Process` makes a call just for the notes when no live call heard it (`notesOnly`), uploads (`RecordingUploader`: parts of `CUE_UPLOAD_PART_BYTES`, 5 MiB at least except the last, three retries
  with a wait, resume from the parts the server has, `CUE_UPLOAD_BREAK=n` loses the connection once), `POST /v1/calls/:id/notes`, and follows `GET /v1/notes/:id/events` (`CueApi.FollowNoteEvents`: SSE, picked up again where it dropped) writing every `line` to the session
  log; when the note is ready the server's note is written over the file (`NoteMarkdown.Render`, front matter `note: ID`). `Rename`, `ApplySuggestion`, `DismissSuggestion` are `PATCH`es and then the same file edit; `MoveToTrash` is `DELETE` and the Recycle Bin
  (`Shell.MoveToRecycleBin`, the audio too). `SyncWithAccount` (after the projects, in `CueApi.OnSignedIn`) imports files without a `note:` (`📦 Imported N notes from this PC`: **"this PC"**, as the projects) and restores the account's others
  (`☁️ Restored N notes from your account`). `Ready` is raised with a note's id when its notes are ready (the calendar slice's "Record?" flow waits on it).
- **The pages**: `ProjectPage`'s Notes tab is `NotesView` (the list with search and Record on the left; on the right the note's tools — Copy Markdown, Show in Explorer, Move to Recycle Bin — a `PlayerBar` when it has audio, the steps a new note goes through (kept only if one
  failed), the suggested names with Apply and ✕, and the note rendered by `MarkdownView`, where a speaker's name opens the rename dialog and a timestamp plays from there). The open note is `Dashboard.NoteId` (`OpenNote(id)`: after Stop, from Home's Recent Notes);
  `NotePlayer` is Windows' media player, headless; a note whose audio isn't in the library is fetched from the account with the token into `Application Support\Cue\cache\audio` and played from there (the Mac streams it; this is one download of about 15 MB an hour,
  removed at sign-out). `RecordControl` is the record button: a red dot and "Record"; while recording the time in a drop-down with Stop Recording; "Saving…" after Stop. It is in the overlay's bar (`RecordSlot`) and on the Notes page.
- **`CUE_CONTROL`** (`RecordingCommands`): `record` (the overlay's button: toggles), `timestamp HH:MM:SS` (plays the open note from there), and for the open note `rename NAME | NEW`, `apply LABEL`, `dismiss LABEL`; `page NAME/notes` opens the tab.
  UI Automation shows a XAML `ScrollViewer`'s content only as far as it is on screen: a case that reads far down a long note makes the window taller first (`size W H`).
- **Cases** `w4-…`: `record` (a two-sided rehearsal into ready notes: every log line in order, the file, its audio, both sides at the second pass, the account's note, the page, a timestamp playing where there is a sound device), `upload-resumes` (`CUE_UPLOAD_BREAK`),
  `step-fails` (the second pass failing: the live transcript kept, the steps on the page), `speakers` (restore a note made by the API; ✕, Apply and the rename dialog through UI Automation), `trash` (Recycle Bin, account and storage), `audio-off` (Keep audio and the summary off: no audio, no summary, nothing left on the PC or in the account; the switches in Settings), `import-restore`
  (a local note up, an account note down, a second launch changes nothing), `record-controls` (Win+Alt+C, the overlay's button and timer menu; real keys, so `needInteractiveDesktop()`),
  `page-follows` (the Notes page open while a note is made and Cue stopped meanwhile: it follows the note to the ready one by itself). They build the account's notes without the app with `recordCall` / `makeNotes` (the `9c-…` helpers)
  and `cue.standIns({ FAKE_DEEPGRAM_FILE, FAKE_CLAUDE_SUMMARY })`; `hasAudioOutput()` is `needAudioOutput()` as a question.

## Meetings, the calendar and notifications on Windows (`apps/windows/Cue`: `Core/{Meetings,MeetingCalendar,MeetingMonitor,MeetingNotifier,MeetingCommands,Preferences.Meetings}.cs`, `Views/{UpcomingPage,CalendarView}`)

The port of `MeetingMonitor`, `MeetingNotifier`, `MeetingCalendar`, `UpcomingView` and `CalendarSettings`, on the recordings above. The behaviour, the session-log lines (`🔔 Record “Title”?`,
`🔔 Not now: “Title”`, `📅 Recording “Title” into PROJECT`, `📅 APP let go of the microphone — stopping the recording`, `🔔 Notes from “Title” are ready`, `🔔 Nothing was recorded in “Title”`) and the
`CUE_CONTROL` commands (`assign EVENT | PROJECT`, `notification record|dismiss`, `settings calendar`, `page upcoming`) are the Mac's. `state.Calendar` (`MeetingCalendar`) and `state.Meetings` (`MeetingMonitor`) are the
two places the rest of the app finds them; the monitor starts with the app, and `Shutdown` (quit) withdraws the notifications' registration.

- **Which apps use the microphone** (`CallApp.UsingMicrophone`): Windows' own record of it, `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone`. An app that opened a microphone has a key (a Store app by its package
  family name; a program one installs under `NonPackaged`, its path with `#` for `\`); it is on the microphone while `LastUsedTimeStop` is 0. The registry is read every `CUE_MEETING_TICK` seconds (5). The call apps are Zoom, Teams, Webex and Slack (on their own too: a "Zoom call"),
  and the browsers, which count only during a calendar call (`CallApp.All`: program file names and package prefixes). `CUE_MIC_APPS=file` stands in for the registry in a case (one program file name, path or package family name per line, read on every check); a case that
  wants the registry itself sets it to the empty string and writes keys (`w6-mic-registry`). A call app letting go of the microphone for `CUE_MIC_RELEASE` seconds (60) is the call's end: the recording Cue started stops (`RecordingTrigger.CallEnded`, `automatically: true`) and the next call in that app is offered again.
- **The calendar's source** (`MeetingCalendar`): **Windows' appointment store**, `Windows.ApplicationModel.Appointments.AppointmentManager` with `AllCalendarsReadOnly`. A desktop program with no package identity may read it, with no sign-in of Cue's own and no Microsoft Graph:
  it holds the calendars of the accounts added in Settings › Accounts (Outlook, Exchange, Google, iCloud: whichever the PC has) and of the apps that write to it. Today and tomorrow are read (the monitor's tick asks, the store answers at most every 15 s, and Upcoming and Settings › Calendar ask for a fresh look when they open), recurring appointments expanded by the store into one
  per day, and an appointment is a call when its online-meeting link, URL, location or details hold a Meet, Zoom, Teams or Webex link (`CallServices.LinkIn`). **The store asks for the properties it hands back** (`FindAppointmentsOptions.FetchProperties`: without `Details` a link in the notes is lost). Whether it holds a given person's meetings depends on
  what they added to Windows: that is the one thing this cannot promise (the new Outlook and Teams keep theirs to themselves), and the Mac's EventKit does not have the problem. Access refused or no calendar service (`CalendarAccess`) is said on Upcoming and in Settings › Calendar.
  `CUE_CALENDAR_EVENTS=file.json` replaces it in a case, in the Mac's format (`title`, `start`, `end`, `id`, `series`, `calendar` by name, `url`, `location`, `notes`, `attendees`, `recurring`), read again on every refresh; `tools/appointments.ps1 add FILE|remove` puts appointments into the real store (an app calendar "Cue e2e"; it prints
  `unavailable: …` where the PC has no calendar service, and the case skips) for `w6-appointment-store`.
- **Projects and settings**: the project an event's notes go to is picked per series on Upcoming (a `ComboBox` per row, "Project of TITLE") and kept in `settings.json` (`meetingProjects`, by series), else **Meetings**, created at the first recording (`MeetingMonitor.ProjectFor`); a renamed project keeps its picks.
  Settings › Calendar (`CalendarView`, a tab of `SettingsPage`): *When a meeting starts* (Ask / Record automatically / Do nothing: `meetingAction`) and the calendars with a switch each (`unwatchedCalendars`: off, and Cue never looks in it). Home's *Upcoming Calls* lists the next three, Upcoming the rest of today and tomorrow with *Record* on the one in progress.
- **Notifications** (`MeetingNotifier`): the Windows App SDK's `AppNotificationManager`, registered at run time (`Register()` in the constructor, `NotificationInvoked` subscribed first), which works for a program that is not packaged: nothing in the MSI. A prompt is a toast "Record “TITLE”?" with *Record* and *Not Now*; a note's ready is "Notes Ready"
  (clicking it opens the note); each carries a hashed tag, so a prompt is withdrawn (`RemoveByTagAsync`) when its call is over. **Every notification is written to the session log first, and under `CUE_CONTROL` they go only there** (the harness always sets it): `notification record|dismiss` answers the latest prompt. `CUE_SYSTEM_NOTIFICATIONS=1` (a hook only here) makes the real toasts appear under `CUE_CONTROL` too, for `w6-toast-record`: UI Automation cannot see the shell's toast window, so `tools/toast.ps1` (`clickToast(button)`) captures the corner of the screen where the banner is, reads its words with Windows' OCR and clicks the lowest one that is the button's name with a real mouse click; the case skips when no banner with that button ever appears (a runner whose session shows no toasts, Focus assist). A toast's banner lasts about five seconds and then waits in the notification center, which is how Windows does it.
- **Cases** `w6-…`: `upcoming` (the calls, their projects, Settings › Calendar and a calendar's switch), `meeting-prompt` (calendar plus a browser: one prompt, Not Now is remembered, calls without a link or over don't count), `meeting-record` (Record: the meeting is recorded into its project with the event's title and attendees, stops when the app lets go, notes written and "ready"),
  `meeting-auto` (Record automatically: no prompt, Meetings created, the live language), `meeting-nothing` (Do nothing), `meeting-project` (the pick is remembered for the series after a relaunch), `native-call` (a Zoom call that is in no calendar; nothing said, no note; asked again), `mic-registry` (the real consent store, with keys a case writes and deletes),
  `appointment-store` (the real appointment store, through `appointments.ps1`). `toast-record` (Record on the real toast, clicked: the recording starts in the meeting's project and its notes are written). They read the window with `windowText`; **a `ComboBox` shows in it as its name and then its selected item** (`tools/uia.ps1` reads the selection pattern: a WinUI combo box has no value).

## Where work runs: the VMs and Boat

This Mac edits the code and drives the machines (VMPal, the `boat` CLI); it builds and tests nothing. **Cue for macOS is built and every Mac case
runs in the Cue macOS VM, Cue for Windows is built and every Windows case runs in the Cue Windows VM** (both VMPal's), **the backend is built and
checked in Boat** (`vp check`, `cf build`, `deploy:dry`, installs), and the backend's own cases, being tests, run in a VM too (`--no-app`).
`run.ts` refuses to run on a Mac that isn't a VM, and `build.sh` too (unless `CI` is set: CI builds the apps). `tests/e2e/remote.ts` is the way there, for agents and
people alike:

```bash
node tests/e2e/remote.ts mac e2e 20-                 # Cue.app built in the Cue macOS VM, then the cases whose name starts with 20-
node tests/e2e/remote.ts mac e2e --no-app 9a- 9b-    # the backend's own cases, in the same VM
node tests/e2e/remote.ts windows e2e w --except=w1-  # Cue.exe built in the Cue Windows VM, then every w case but the installer's
node tests/e2e/remote.ts windows --admin e2e w1-     # the installer's cases, elevated
node tests/e2e/remote.ts boat check --fix            # vp check in this checkout's Boat sandbox; what it fixed comes back here
node tests/e2e/remote.ts boat pnpm --filter api deploy:dry
node tests/e2e/remote.ts mac apps/mac/scripts/build.sh   # any command, in this checkout's copy there
node tests/e2e/remote.ts windows cua call list_apps  # Cua Driver in the Cue Windows VM (cua-driver ARGS…), at once
node tests/e2e/remote.ts status                      # the machines; `remote.ts TARGET stop` suspends the VM or stops the sandbox
```

- **One VM of each, made by the harness and reused**: `remote.ts` finds the VM by its name and makes it the first time (`vmpal create`: macOS 27
  downloads 27 GB and installs in about an hour, Windows 11 for Arm half an hour), installs its toolchain as administrator (`apps/mac/scripts/setup.sh`:
  Xcode selected and its license accepted, Node.js 26, pnpm, Chrome; `apps/windows/scripts/setup.ps1`), then Cua Driver (below), and snapshots it
  as `cue-toolchain-HASH` (one per toolchain; VMPal takes none of a running VM while this Mac is locked, so a later command takes it). Every checkout and agent uses that VM after: **never make another VM for Cue, and never delete one** (a VM gone
  wrong goes back to its newest snapshot: `vmpal revert "Cue Windows"`). A VM that isn't running is started in the background, without its
  window, and signed in. A new Mac VM needs four things done for it, which `remote.ts` does: a restart onto VMPal's network for every VM (until
  then it is on the shared network, which gives it no address on this Mac, so VMPal can't put its Tools in it); VMPal Tools, when VMPal
  couldn't (their installer, in `My Shared Files › VMPal Tools`, through the VM's screen); VMPal Tools' administrator part, which macOS's own
  prompt allows (VMPal types the password it keeps for the VM; again after VMPal Tools update); and Xcode, copied from this Mac's
  `/Applications/Xcode.app` (the Command Line Tools can't build Cue: SwiftUI's macros are Xcode's plugins; Apple's downloads need an Apple Account).
- **Each checkout has its own copy**: `C:\cue\ID` in Windows, `~/cue/ID` in the Mac (ID as in `run.ts`'s work folder; `status` prints it), and on
  Boat a sandbox of its own (`cue-WORKTREE-ID`, the copy in `/home/user/cue`), made the first time, resumed after it stopped (when idle, by itself).
  Every command first makes the copy this checkout — what git tracks and the untracked files it doesn't ignore, uncommitted work included — leaving
  `node_modules`, `build`, `.build`, `obj`, `bin` and `.cloudflare` alone; the toolchain is installed again when one of its scripts changes, the packages
  (`pnpm install`, `pnpm --filter api types`) when `pnpm-lock.yaml` or `cloudflare.config.ts` do.
- **`e2e`** is `node tests/e2e/run.ts ARGS…` there. The cases' logs come back to `$TMPDIR/cue-remote-ID/TARGET-logs`; their sandboxes stay in the
  VM, in `E2E_WORK` (the copy's folder plus `.e2e`). **One run at a time on a machine**: `run.ts` holds a lock file (`/Users/Shared/cue-e2e.lock`,
  `%PUBLIC%\cue-e2e.lock`), and a run that finds another's waits for it to end (`Waiting for the run of CHECKOUT (process N, since …) to end`), so
  checkouts never share the desktop, the audio or the processor; a run gone without removing it is noticed. `--real-deepgram` reads the key from the VM's own login keychain: add it there.
- **By hand**: the `vmpal_*` tools work in the same VMs (`vmpal_exec` with `cwd` the copy; VMPal's command line is `vmpal`, once `vmpal help setup`'s
  link is made, else `remote.ts` uses the one inside VMPal.app). A process `vmpal_exec` starts ends with the command: to look at a window yourself,
  start Cue so it outlives it (`Invoke-CimMethod -ClassName Win32_Process -MethodName Create` in Windows, `open` or `nohup` in the Mac) and read the
  window with `vmpal_screenshot`, in both themes (`CUE_APPEARANCE=light|dark`).
- **Cua Driver** (github.com/trycua/cua) is the fine control of the apps in a VM, its command line only (no MCP server): `remote.ts mac|windows cua
  ARGS…` runs `cua-driver ARGS…` there at once, without copying the checkout. `cua call list_apps` / `list_windows` (pids, window ids), `cua call
  get_window_state '{"pid":P,"window_id":W,"session":"NAME"}' --screenshot-out-file shot.png` (the window's accessibility tree on the Mac, UI
  Automation's on Windows, with element indices, and its screenshot, which comes back to this Mac), then `click`, `type_text`, `press_key`,
  `scroll`, `set_value`… with `"element_token":"SNAPSHOT:INDEX"` and the same `session` (a call without one is a session of its own, whose
  snapshot is gone when it returns). Input goes to that window in the background: the VM's pointer and focus stay where they were (it says when a
  window needs the foreground). `cua list-tools` and `cua describe TOOL` say the rest. Use it to look at and work windows by hand, Cue's
  included; the cases don't use it (they drive Cue through `CUE_CONTROL` and read it through the session log, snapshots and `windowText`), and
  `vmpal_screenshot` / `vmpal ui` stay what sees the VM's whole screen (sign-in, system prompts). It is part of the VMs' toolchain
  (`tests/e2e/tools/cua-driver.sh` and `.ps1`: a pinned release, its installer checked by SHA-256, telemetry and update checks off; its daemon is a
  LaunchAgent on the Mac, the Scheduled Task `cua-driver-serve` on Windows). Its own rules refuse some calls in its `standard` mode (`kill_app` of
  a process another session started): don't work around a refusal. **The Mac VM needs a person once**: macOS lets only someone at the Mac switch
  an app on under Privacy & Security, and until then every call answers `permissions_pending`. `remote.ts mac cua permissions grant` brings the
  VM's window forward and waits while they click Open System Settings and switch CuaDriver on under Accessibility and under Screen & System Audio
  Recording; agents never click those switches. `cua permissions status --json` says how it stands.
- **Boat**: docs at https://docs.boat.dev/llms.txt; prices and limits: run `boat limits`, never quote prices from memory. `boat exec ID --cwd cue …`
  works in the sandbox as well (`boat list` names it). An SSH connection does not keep a sandbox alive.
- A check that couldn't run (no VM yet, VMPal not running) is reported as not run, with why. A Boat check is not evidence that an app builds or
  passes its cases.

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
  headless (`E2E_BROWSER=path` names another; the Cue macOS VM has it (`setup.sh` installs it); a machine without one skips the
  case) for the cases that use the admin SPA as its owner does. Never for the Mac app, which is driven by `CUE_CONTROL`.
- **The suite reads images with macOS Vision** (`tools/ocr.swift`, its accurate recognizer), **or Tesseract where that can't run**: in the Cue
  macOS VM it fails on every device (and the fast one reads neither Cyrillic nor small text), so `ocr` exits with 3 and `harness/tesseract.ts` reads
  the images `ocr --prepare` writes (over white, and over black inverted) with `tesseract.js` (WebAssembly, in `tests/e2e` with the English and
  Ukrainian data of `@tesseract.js-data`: it downloads nothing). The probe says which reads (`read by Tesseract (…)`). Its misreads that can be
  told from the rest are corrected (`corrected` there); two can't: `→` is read as another character and a bold title's "Sign in" as "Signin",
  so a case looks for those with `.` and ` ?`.
- Stand-ins are allowed only at the outer boundary, never for Cue's own code:
  - the paid cloud providers the backend calls: `harness/fake-providers.ts` serves the Anthropic Messages API and Deepgram's live speech-to-text
    (live and recorded files) from the case's own process, as the backend's upstreams (`ANTHROPIC_URL`, `DEEPGRAM_URL`), and takes only the owner's keys in `FAKE_KEYS`
    (the backend gets them as `ANTHROPIC_API_KEY` / `DEEPGRAM_API_KEY`). The Anthropic one answers as `FAKE_CLAUDE_ANSWER` sets (`FAKE_CLAUDE_ANSWERS`
    one per question matching a pattern; as the question judge it finds the sentences ending in "?", or replies as `FAKE_CLAUDE_JUDGEMENTS` says,
    and `FAKE_CLAUDE_JUDGE_FAILS=1` makes it fail, `FAKE_CLAUDE_JUDGE_DELAY` slow; `FAKE_ANTHROPIC_OVERLOADED=N` answers the judge's first N
    requests with a 529, `FAKE_ANTHROPIC_CUT=N` breaks off the first N answers partway), simulates the prompt cache and reports `usage`. The
    Deepgram one takes a continuous stream of PCM per channel, tells speech from silence by loudness, and answers each stretch of speech (an
    utterance, ended by 700 ms of quiet) with the next line of `FAKE_DEEPGRAM_LIVE` (a JSON array in the order utterances start across both
    channels; an entry is a string, or `{text, speaker, language}`) or "Utterance N."; `FAKE_DEEPGRAM_DROP=N` drops the connection of
    the Nth utterance as it starts. Asked for `language=multi` (always, now) each result says its language: the entry's `language`, else `uk` for Cyrillic and `en` otherwise. For the notes Workflow it also reads a recorded file (`POST /v1/listen`): one utterance per stretch of speech in it,
    worded by `FAKE_DEEPGRAM_FILE` (a JSON object `{"me": […], "others": […]}`, entries as above, in order; a side without an entry says "Second pass by Deepgram, part N."),
    with each word's `speaker` when the request has `diarize` (`FAKE_DEEPGRAM_FILE_FAILS=N` fails the first N such requests with a 500, `FAKE_DEEPGRAM_FILE_DELAY` slows them);
    the Anthropic one has a second system prompt kind, the names step ("You find the names…"), answered by `FAKE_CLAUDE_NAMES` (a JSON object label → name; by default the
    `<!-- speaker: … -->` lines of the summary's fixture), and `FAKE_ANTHROPIC_SUMMARY_FAILS=N` fails the first N summaries; a third, a project's brief ("You read the
    materials…", noted as `brief-system` and `brief-input`), is answered by `FAKE_CLAUDE_BRIEF` (the JSON object `prompts/brief.md` asks for; by default an empty one) and
    `FAKE_ANTHROPIC_BRIEF_FAILS=N` fails the first N (`FAKE_CLAUDE_BRIEF_DELAY` slows it by that many seconds); a note's translation ("You translate the notes…", `translate-system` / `translate-input`) is answered in the shape asked
    for. With two languages, what is asked for in the other one (an answer's `» ` lines, the judge's `T: ` lines, a note's lines) is `FAKE_CLAUDE_TRANSLATIONS` (JSON, line →
    translation) where it has the line, else `(LANGUAGE) line`; `FAKE_CLAUDE_TRANSLATED_SUMMARY` (a file) is a note's translated summary. The variables are read from the environment the app was launched with (`cue.launch({…})`) or from
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
- Some Macs can't do what certain cases need: GitHub's runners drew the overlay blank. Before the
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
  Linux too, and in either VM (`remote.ts mac e2e --no-app …`; all of `9a-` but `9a-admin-disable-app`, which signs the Mac app out). They use `backend.tokensFor(email)`, `backend.signInAs(email, { provider, verified })`,
  `backend.refresh(token)`, `backend.revoke(token)`, `backend.get(path, accessToken)`, `backend.invite(email)` and
  `backend.disable(email)` (the owner's script), the stand-in `backend.idp` and `backend.log` (the Worker's output). The admin's:
  `backend.adminAs(email)` (an `AdminClient` with the session cookie a browser would get: `get`, `call(method, path, body, origin)`, the origin the admin's),
  `backend.admin()` (starts the case's admin SPA under `cf dev`, talking to its backend, and returns its origin, `backend.adminUrl`; `AdminPage` calls it),
  `backend.seedUsage(email, rows)` (rows of the `usage` table, as the backend writes them) and `AdminPage.signIn(backend, email, { scheme, viewport,
  shots })` (`harness/browser.ts`: the SPA in a browser, signed in through the stand-in provider; `.page` is Playwright's, `.shot(name)` writes a
  screenshot into the case's sandbox, `.assertClean()` fails on console errors, exceptions and 5xx, `.navigate('Users')` follows the navigation).
- **Recordings and notes without the app** (`9c-…`): `harness/recordings.ts`. `recordCall(cue, backend, email, …)` makes a call (optionally live, so the Call DO holds lines) and the two
  sides' WAVs; `uploadRecording(backend, token, callId, side, take, file, { partBytes, breakAt })` uploads in parts the way the app does and can lose the connection partway
  (a real cut socket) and resume; `startNotes` / `makeNotes` start the Workflow, `waitForNote` waits for `ready`, `noteEvents` reads the SSE stream (`after`, `lastEventId`),
  `getNote`; `account.notes(project?)` / `account.note(id)` read a person's notes from outside the app. Parts must be 5 MiB or more (R2's rule, enforced by the local R2 too):
  generate long audio (`bursts` writes it instantly) when a case needs several. `cue.backend({ env: { NOTES_RETRY_SECONDS, RETENTION_DAY_SECONDS, RETENTION_TICK_SECONDS } })` shortens
  a retry's wait and the retention's "day". `cue.serviceRequests('deepgram-file')` reports the recorded-file requests.
- **Live calls without the app** (`9b-live-…`, also Linux-friendly): `startCall(backend, email, { materials, namesAndTerms, call })` signs in,
  makes a project with the files as materials and starts a call; `LiveClient.connect(backend, token, callId, after?)` is the app's socket
  (`play(channel, pcm)` streams audio in real time, `command({…})`, `next(type, check, seconds)` waits for an event, `of(type)`, `answerTo(questionId)`,
  `drop()`); `bursts(out, seconds, [[from, to]…])` writes loud sound where the Deepgram stand-in should hear speech and silence elsewhere (no
  voices needed), `pcmOf(wav)` its samples; `cue.standIns({…})` says how the stand-ins reply; `cue.backend({ env: {…} })` can shorten
  `CACHE_TICK_SECONDS`, `CACHE_REFRESH_SECONDS` and `CALL_GRACE_SECONDS`. `cue.serviceRequests('anthropic-request' | 'deepgram-live')` and
  `cue.claudeRequests(kind)` report what reached the stand-ins (a Deepgram stream is noted when it ends).

### Running the cases

The suite is TypeScript run by Node 26 or later, which strips the types
itself: no build step, no transpiler, no runtime packages.

`run.ts` runs in a VM, one run at a time: from this Mac, `node tests/e2e/remote.ts mac e2e ARGS…` and `… windows e2e ARGS…` run it there (see Where work runs).

```bash
node tests/e2e/run.ts                  # build the app, then run every case
node tests/e2e/run.ts --no-build 4 5   # the existing build; cases whose name starts with 4 or 5
node tests/e2e/run.ts --no-app 95-     # no app at all: only cases about the backend (on any machine Node runs on)
node tests/e2e/run.ts --real-deepgram 83 84   # the backend's Deepgram is the real one, its key from the keychain
node tests/e2e/run.ts --keep           # keep every sandbox (a failed case always keeps its own)
node tests\e2e\run.ts                  # on Windows: build apps/windows (build.ps1), then the w… cases and the backend's own (no app launched)
node tests\e2e\run.ts --no-build w0-  # on Windows: the app already built (apps\windows\build\ARCH\Cue.exe)
node tests/e2e/remote.ts boat check    # format, lint, type-check (vp check, in Boat; `check --fix` brings fixes back); run it before you commit
```

The runner compiles the Swift tools in `tests/e2e/tools/` that need Apple's
frameworks (`ocr`, `dialogue`, `audio-sync`, `windows`) when their source
changes, runs the cases one at a time (each a `node:test` test in its own
process), and prints one line per case with the failing output. Everything a run makes —
sandboxes, each case's log, the tools, the dialogue and speaker-model caches, Tesseract's data
— is in `E2E_WORK` (by default one folder per checkout under `$TMPDIR`).
Cases run in the VMs, which are nobody's desktop, so on the Mac every Cue a case launches is in front as in normal use: it activates, has
its Dock and menu bar icons and its hot keys, and its windows come up over the others (only `04-background` and `05-background-snapshots` set
`CUE_BACKGROUND=1`, the hook they are about). Under `CUE_CONTROL` an alert goes only to the session log, so nothing waits for a click. On
Windows `cue.launch` still sets `CUE_BACKGROUND`. Every
Cue it launches is in US English too (`-AppleLocale en_US`), whatever the
Mac's region, so cases can look for `$2.50` and `Nov 1`. A window
captured on screen shows only what is scrolled into view: a case that reads
text far down a page, and doesn't find it, makes the window taller
(`size W H`). Only then, because a window asked to be larger than the screen
is cut to it, smaller than it was (GitHub's runner has a small screen).

### Writing a case

Each case is a TypeScript file, `tests/e2e/cases/NN-name.test.ts`, numbered
by feature area (`0x` CLI and launch, `1x` prompter and recording, `2x`
projects and dashboard, `3x` call audio, `4x` the notes' second pass (upload, steps, retries), `5x`
speakers, `6x` calendar, `7x` the backend's Anthropic calls, `8x` Deepgram through the backend, `9x` signing in, the backend and the admin: the admin's are `9a-…`, the live calls' `9b-…`, the notes' `9c-…`, the limits, usage and rate limits' `9d-…`, the Windows app's OAuth client `9e-…`, the brief's events `9f-…`; `wN-…` are Windows-only: `w0-…` the Windows app, `w1-…` its installer). It declares one test, whose title says the
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
| `CUE_CONTROL=file` | Run each line appended to `file` as a click would: `new NAME` (New Project), `add PATH` (drop a file on the open project's materials), `start NAME` (Start Cue), `project NAME` (the overlay's project menu), `page home\|upcoming\|NAME\|NAME/answers\|NAME/notes` (show a dashboard page), `ask TEXT` (the Ask field), `timestamp HH:MM:SS` (a timestamp in the open note's transcript: plays its audio from there), `assign EVENT \| PROJECT` (an Upcoming call's project picker, by event title), `notification record\|dismiss` (Record / Not Now on the latest prompt), `rename NAME \| NEW` (a speaker's name clicked and renamed in the open note), `apply LABEL` / `dismiss LABEL` (Apply or ✕ on a name suggestion of the open note), `show TEXT` (the overlay's row of the question with TEXT in it), `newest` (the overlay's New Questions button), `prepare` (Prepare Answer on the newest questions waiting for it), `record` (the overlay's record button, or Stop Recording in its timer's menu), `settings general\|account\|calendar` (Settings on that tab), `set PROJECT | occasion|names | VALUE` (a field of the project's page edited), `remove PROJECT | FILE` (a material's minus button), `size W H` (the dashboard's edge dragged until it's W × H points, or as small as it goes), `signin` (Sign In on Home), `signout` (Sign Out in Settings › Account), `languages CODE CODE` (Settings' language pickers; alone: none), `answer-layout subtitles|mirror|focus` and `note-layout switch|both` (how two languages are shown), `note-language CODE` (the open note's language switch) and `update check\|restart` (Check Now / Restart to Update in Settings › General). Until someone is signed in only `signin`, `signout`, `settings`, `page`, `size` and `update` do anything (the rest log `⚠︎ Sign in to Cue first (…)`). Notifications then go only to the session log (`🔔 …`), not Notification Center, so no permission is asked. |
| `CUE_CALENDAR_EVENTS=file.json` | Read the calendar from this file instead of EventKit (no permission asked), again on every check: a JSON array of `{title, start, end}` (ISO 8601) with optional `id`, `series` (shared by a recurring event's occurrences), `calendar` (name), `url`, `location`, `notes`, `attendees` (names), `recurring`. |
| `CUE_MIC_APPS=file` | The bundle IDs using the microphone right now, one per line, read on every check instead of Core Audio's process list. |
| `CUE_MEETING_TICK=s` / `CUE_MIC_RELEASE=s` | Check for calls every `s` seconds instead of 5; stop a call's recording once the call app has been off the microphone for `s` seconds instead of 60. |
| `CUE_API_URL=url` | The Cue API (`CueAPI.baseURL`, default `https://api.cue.app`): the backend a case runs. |
| `CUE_WEB_AUTH=headless` | Sign in without the browser sheet: `CueAPI` follows the authorize URL with `URLSession` (cookies, the sign-in page's Google button) up to the redirect back to the app, which it keeps. |
| `CUE_UPDATE_URL=url` | Read the latest release from `url` (a stand-in for GitHub's `/repos/OWNER/NAME/releases/latest`: `cue.releases()`) and update from it, whatever the build; without it a Cue under `CUE_HOME` never looks for updates, and only a release build (`CueUpdates` stamped) looks at all. |
| `CUE_UPDATE_TICK=s` | Look for an update every `s` seconds instead of every 6 hours (and once at launch, as always). |
| `CUE_ME_TICK=s` | Read the account (`/v1/me`: usage, still allowed?) every `s` seconds instead of 300; a signed-out Cue with a saved refresh token tries again at the same pace. |
| `CUE_ALLOW_CAPTURE=1` | Let screenshots see the overlay. |
| `CUE_SHOW_SETTINGS=1` | Open Settings at launch. |
| `CUE_BACKGROUND=1` | Stay out of the way of whoever is using the Mac (a case's Cue is in front, as the VM is nobody's desktop; `04-background` and `05-background-snapshots` set it): Cue never activates itself or takes keyboard focus, and has no Dock icon, menu bar icon or hot keys; its windows sit behind every other window — just above the desktop picture, under the desktop's icons, in every Space — where `CUE_SNAPSHOT` still captures each one alone (drawn as an inactive app's window). An alert goes only to the session log (`⚠︎ …`) instead of waiting for a click. |

To look at a design you changed, run the app in the Cue macOS VM in a sandbox with snapshots on, show the page,
copy the PNGs out and read them as images — then the same in the other appearance:

```bash
node tests/e2e/remote.ts mac apps/mac/scripts/build.sh
node tests/e2e/remote.ts mac /bin/zsh -c 'home=~/cue/look; rm -rf $home; mkdir -p $home
CUE_HOME=$home CUE_NO_LIVE_AUDIO=1 CUE_SHOW_SETTINGS=1 CUE_APPEARANCE=dark \
  CUE_SNAPSHOT=$home/cue.png CUE_CONTROL=$home/control apps/mac/build/Cue.app/Contents/MacOS/Cue & pid=$!
sleep 3; echo "new Bee talk" >> $home/control   # any CUE_CONTROL line: page home, start NAME, …
sleep 5; ls $home/*.png                         # cue.png (overlay), cue-dashboard.png, cue-settings.png
grep 📸 $home/Application\ Support/Cue/sessions/*.md; kill $pid'   # then CUE_APPEARANCE=light
vmpal cp "Cue macOS:cue/look/." "$TMPDIR/cue-look"   # or vmpal_copy_out
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
`✨ Prepared “PROJECT” from its materials: N answers, M names and terms`, `⚠︎ Couldn't prepare “PROJECT” from its materials: …`, `🌐 Language heard: NAME`,
`🌐 Languages: English, Ukrainian` (or one, or `none — Cue follows the language it hears`), `⚠︎ Couldn't save your languages: …`, `🌐 Translating notes…`, `✅ Notes translated into NAME: N lines`,
`☁️ Saved “PROJECT” to your account`, `⚠︎ Not invited: EMAIL`, `⚠︎ Couldn't sign in to Cue: …`, `⚠︎ Sign in to Cue first`,
`📝 Notes ready: …`, `📅 Recording “Title” into Project`, `🔔 Record “Title”?`,
`✅ Cue is up to date (VERSION)`, `🔄 Downloading Cue NEW (this is OLD)…`, `✅ Cue NEW is installed: it opens the next time Cue starts` (the Mac) or
`✅ Cue NEW is downloaded: it installs when Cue restarts` (Windows), `⚠︎ Couldn't update Cue: …`, `🔄 Restarting Cue to finish the update to NEW`,
`✅ Cue was updated from OLD to NEW` (the next Cue)
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
- Build with `apps/mac/scripts/build.sh` (`apps/windows/scripts/build.ps1` for Windows) before running cases, in its VM (`run.ts` does it, through
  `remote.ts … e2e`); the build must be warning-free for new code.
- Match the surrounding code: comment density, naming, SwiftUI and HIG idioms
  (standard controls, semantic colours, system Liquid Glass).
- One feature per branch and PR, with its e2e case in the same PR.

## Updates (`apps/mac/Sources/Cue/Updater.swift`, `apps/windows/Cue/Core/Updater.cs`)

Both apps update themselves from the repository's latest GitHub release (what `release.yml` publishes), with no service of their own: `GET
https://api.github.com/repos/OWNER/NAME/releases/latest` when Cue opens and every 6 hours (while Settings › General's *Update Cue automatically* is on; *Check Now*
and the Mac's *Check for Updates…* look at once), the asset for this platform by its name, and its `size` and `digest` (`sha256:…`, which GitHub gives every asset)
checked before anything is installed. A newer version is one whose tag (`vMAJOR.MINOR.PATCH`) is later than this Cue's version.

- **Which builds look**: a release build only: `build.sh` and `build.ps1` stamp the repository (`CueUpdates` in `Info.plist`, assembly metadata `CueUpdates`) when
  `CUE_UPDATES=OWNER/NAME` is set, which `release.yml` does. A local build, a case's build and any Cue under `CUE_HOME` never ask GitHub; `CUE_UPDATE_URL` points one at a stand-in.
- **The Mac**: `Cue-VERSION.zip` is unpacked (`ditto`) into `Application Support/Cue/updates`, and the app in it must be Cue (bundle identifier), the release's version, valid
  (`codesign --verify --deep --strict`) and for this macOS (`LSMinimumSystemVersion`); then it takes the place of the running Cue.app (`FileManager.replaceItemAt`: one swap where
  Cue.app is, refused when Cue runs translocated or the folder isn't writable). The running Cue goes on; the new one opens at the next start or with *Restart to Update* (Settings,
  the menu bar icon: a shell waits for this Cue to be gone, then `open`s the app; under `CUE_HOME` it runs the executable with this environment but `CUE_CONTROL`). `updates/installed.json`
  says what was replaced, for the next Cue's `✅ Cue was updated from OLD to NEW`. The builds are signed ad hoc, so macOS asks for the microphone and call audio again after each update.
- **Windows**: `Cue-VERSION-ARCH.msi` (the process's architecture) is downloaded into `%LOCALAPPDATA%\Cue\Updates` (`CUE_HOME`'s `updates`), and `ready.json` keeps it. An MSI can't replace
  a running Cue, so it installs when Cue goes: *Restart to Update* (Settings, the notification area), quitting Cue, or the next launch (before any window). `install.ps1`, written there
  and run hidden with Cue's environment but `CUE_CONTROL`, waits for Cue's process to end, runs `msiexec /i … /passive` (`/qn` under `CUE_BACKGROUND`; Windows Installer asks for
  permission itself, as the MSI is per machine), writes its exit code to `result.txt` and, for a restart, opens Cue again (not elevated: the script isn't). The next Cue reads `update.json`
  and says how it went (`✅ Cue was updated …`, or `⚠︎ Cue NEW wasn't installed: the installation was cancelled` / `⚠︎ Couldn't install Cue NEW: Windows Installer stopped with code N`).
- **Cases**: `06-update` (the Mac: a download that doesn't match is refused; the matching one replaces a copy of the build in the case's `Applications`; Restart to Update opens it) and
  `w1-update` (Windows, elevated, like `w1-installer`: the installed older MSI downloads the newer, Restart to Update installs it and opens the new Cue). `cue.releases()` is the stand-in for
  GitHub's releases (`harness/fake-github.ts`: `publish({ version, files, wrongDigest })`, `url`, `requests`), `cue.followRestart(bin, seconds)` waits for the Cue that the launched one opened
  as it quit and makes it the running one, and `harness/installer.ts` has the installer's helpers (`buildInstaller`, `builtInstaller`, `installedVersion`, `msiexec`, …).

## CI and releases

- `.github/workflows/ci.yml` runs on pull requests only, and checks the code, nothing more: `vp check` (with `check-vite.ts`), Cue.app built
  (new warnings in `apps/mac/Sources/Cue` fail it) and Cue for Windows with its installers for x64 and arm64 (one `windows-latest` runner,
  arm64 cross-built; warnings fail `build.ps1`). **No case runs on CI**: the end-to-end suite runs in the Cue VMs only, one run at a time (see
  Where work runs). `build-and-test`, the check `main` requires, passes when the check and both builds did. **Run the whole suite in both VMs
  before merging** (`node tests/e2e/remote.ts mac e2e`, `… windows e2e` and `… windows --admin e2e w1-`) and put their summaries in the PR. Keep CI
  green; never fake what's missing. A new push cancels the run it replaces (`concurrency`). No NuGet cache: restoring one from the cache took longer
  than restoring from nuget.org.
- `.github/workflows/deploy.yml` runs on pushes to `main` that touch `apps/api`, `apps/admin`, `packages/contract` or their build (and on demand), never on a fork: `vp check`, the remote
  migrations, `cf deploy`, the migrations again, a check that the Worker answers. It needs the secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and the variable `ADMIN_EMAILS`. Do not
  run it, or `cf deploy` without `--dry-run`, from here.
- `.github/workflows/release.yml` runs on every push to `main`: it builds
  `Cue.app` (macOS runner) and the two Windows installers (`Cue-VERSION-x64.msi`, `Cue-VERSION-arm64.msi`, both from one `windows-latest` runner: the arm64 one is cross-built),
  and publishes a GitHub release `v<version>.<patch>` with all three
  (`<version>` is `CFBundleShortVersionString` in `apps/mac/Resources/Info.plist`,
  bump it for a new minor or major; one version for both platforms) with `scripts/changelog.sh` as its notes:
  every change on `main` since the previous release, one line each, with a
  merged pull request's own commits listed under it, then how to install on each platform (the MSI is unsigned: the notes say what SmartScreen shows).
  Write commit subjects and
  pull request titles that read well in that list.
  `scripts/changelog.sh v2.0.0` prints the notes of an earlier release. Run by hand (Actions › Release › Run workflow) it is a dry run: it builds the
  Windows installers, keeps them as the `Cue-windows` artifact and publishes nothing.
