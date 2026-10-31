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
  `CUE_STATE_DIR` the dev server's port and persisted state. Nothing is deployed from here: `pnpm --filter api deploy:dry` only.
- The owner's script: `pnpm --filter api invite EMAIL` (invite), `… EMAIL --disable` (disable: banned, tokens revoked, on the KV
  denylist so access tokens stop working at once), `… --list`. It works on the local database (`pnpm --filter api migrate` first); with
  `--remote` it goes through `cf d1 raw` and `cf kv keys` to the deployed one, finding it by name (`CUE_D1_ID` / `CUE_KV_ID` name them
  when that fails). The remote path has not run against a real account yet. A user is invited or an `ADMIN_EMAILS` address
  (always invited, the `admin` role); only a provider-verified email may sign in.

## The admin (`apps/api` `/admin/v1`, `apps/admin`)

The owner's admin: usage and money, never content (no transcripts, no notes). `docs/backend.md` › Admin API says what it covers.

- **API**: `src/routes/admin.ts`, a plugin under `/admin/v1`, authorized by a Better Auth session cookie whose user is an owner (`admin` role or
  `ADMIN_EMAILS`): no session `401`, a member `403` (`GET /admin/v1/session` alone answers a member, so the SPA can say "Not allowed"). A write
  must carry this origin's `Origin` header. Schemas are in `packages/contract/src/admin.ts`; money is dollars in the contract and millionths of a
  dollar in the `usage` table; times are milliseconds. Settings (default monthly limit, audio retention, pausing the plan) are rows of `setting`;
  `src/routes/v1.ts` is the `/v1` group (the plan gate, then each feature's plugin: `me`, PR 4's projects, …), and a paused plan makes every route in
  it answer `plan_paused` (503). `/v1/me` reads the limit (`user_limit`, else the default) and the month's usage from `usage`; PR 7 writes that table.
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
  (`--inspect`, `--render`, …) — against real files, real audio, real
  `whisper-server` and real child processes, and checks what a user would see:
  the notes on disk, the audio files, the session log, the rendered windows.
- **The suite's browser is Playwright** (`playwright-core` in `tests/e2e`; it downloads nothing): `harness/browser.ts` drives the machine's Chrome
  headless (`E2E_BROWSER=path` names another; macOS CI has Chrome, a Boat sandbox has `/usr/bin/google-chrome`; a machine without one skips the
  case) for the cases that use the admin SPA as its owner does. Never for the Mac app, which is driven by `CUE_CONTROL`.
- Stand-ins are allowed only at the outer boundary, never for Cue's own code:
  - the paid external service: `tests/e2e/tools/fake-claude.ts` replaces
    the `claude` CLI (through `CUE_CLAUDE_BIN`) so cases are fast and
    deterministic (`FAKE_CLAUDE_ANSWER` sets its answer, `FAKE_CLAUDE_ANSWERS`
    one per question matching a pattern; as the question judge it finds the
    sentences ending in "?", or replies as `FAKE_CLAUDE_JUDGEMENTS` says, and
    `FAKE_CLAUDE_JUDGE_FAILS=1` makes it fail, `FAKE_CLAUDE_JUDGE_DELAY` slow). Cases that judge Claude's actual writing run against the
    real CLI with `node tests/e2e/run.ts --real-claude`;
  - the paid cloud providers of Settings › Providers: `harness/fake-providers.ts`
    serves the Anthropic Messages API (replying as the fake claude does;
    `FAKE_ANTHROPIC_OVERLOADED=N` answers the judge's first N requests with a 529,
    `FAKE_ANTHROPIC_CUT=N` breaks off the first N answers partway) and
    Deepgram (a live WebSocket stream per utterance, answered with the next line
    of `FAKE_DEEPGRAM_LIVE` or "Utterance N.", `FAKE_DEEPGRAM_DROP=N` dropping the
    Nth; a recorded file, answered with one utterance per stretch of speech) from
    the case's own process, through
    `CUE_ANTHROPIC_URL` and `CUE_DEEPGRAM_URL`, and takes only the keys in
    `FAKE_KEYS`. `--real-anthropic` and `--real-deepgram` use the real services
    instead, with keys the runner reads from the login keychain (items
    `Cue e2e Anthropic API key` and `Cue e2e Deepgram API key`, added with
    `security add-generic-password -a "$USER" -s "…" -w`): never put a real key
    in a case, a fixture, the control file or the chat. A recording of a real
    call (someone's conversation) never goes into the repository either: case 84
    reads one from `E2E_REAL_CALL=path` (any recording macOS can read, a screen
    recording's `.mov` too) and skips without it;
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
- A case that needs something the machine lacks (the speech model, a voice,
  a permission, the network) calls `skip('reason')` or a `need…` helper; it
  never fakes the missing piece.
- Some Macs can't do what certain cases need: GitHub's runners have no GPU for
  speech recognition, and may not draw the overlay readably. Before the
  cases, `run.ts` probes the machine once (`harness/capabilities.ts`) for
  three things: whisper-cli must hear a spoken test phrase within 20 s, the
  dashboard's snapshot must read as text, and so must the overlay's once Start
  Cue shows it. It prints what it found (`Speech recognition: yes — 1.4 s for
  1.9 s of speech`), and a case that depends on what's missing skips with that
  reason: `needWhisper()` does it for speech, and the snapshot helpers
  (`snapshotText`, `dashboardPage`, `dashboardShows`) for windows and the
  overlay. Call `needWindowSnapshots()` or `needOverlaySnapshots()` yourself
  before reading a snapshot another way.

### The backend in a case

Cue is for signed-in people, so every case that launches the app runs against the real backend: `apps/api` under `cf dev`, with
local D1 and KV, started by the case.

- **Each case has its own backend** (`cue.backend()`, `tests/e2e/harness/backend.ts`; `cue.launch()` starts it for you): its own port,
  its own database in the case's folder, its own stand-in sign-in and, from PR 5, the Anthropic and Deepgram stand-ins of
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
  `backend.seedUsage(email, rows)` (rows of the `usage` table, as PR 7 will write them) and `AdminPage.signIn(backend, email, { scheme, viewport,
  shots })` (`harness/browser.ts`: the SPA in a browser, signed in through the stand-in provider; `.page` is Playwright's, `.shot(name)` writes a
  screenshot into the case's sandbox, `.assertClean()` fails on console errors, exceptions and 5xx, `.navigate('Users')` follows the navigation).

### Running the cases

The suite is TypeScript run by Node 26 or later, which strips the types
itself: no build step, no transpiler, no runtime packages.

```bash
node tests/e2e/run.ts                  # build the app, then run every case
node tests/e2e/run.ts --no-build 4 5   # the existing build; cases whose name starts with 4 or 5
node tests/e2e/run.ts --no-app 95-     # no app at all: only cases about the backend (they run on Linux, in a Boat sandbox)
node tests/e2e/run.ts --real-claude 45 # the real claude CLI instead of the stand-in
node tests/e2e/run.ts --real-anthropic --real-deepgram 7 8   # the real cloud providers, keys from the keychain
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
windows stay behind all others, where snapshots still capture them.

### Writing a case

Each case is a TypeScript file, `tests/e2e/cases/NN-name.test.ts`, numbered
by feature area (`0x` CLI and launch, `1x` prompter and recording, `2x`
projects and dashboard, `3x` call audio, `4x` second-pass transcript, `5x`
speakers, `6x` calendar, `7x` the Anthropic API and Settings › Providers, `8x` Deepgram, `9x` signing in, the backend and the admin: the admin's are `9a-…`). It declares one test, whose title says the
behaviour it checks:

```ts
import { assertContains, dialogue, e2eCase, fixture, needWhisper } from '../harness/index.ts';

e2eCase('A two-sided rehearsal is recorded into notes with both sides.', async (cue) => {
    needWhisper();
    const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
    await cue.launch({ CUE_REHEARSE_RECORD: '1', CUE_REHEARSE_PARTICIPANT: call.wav('call'), CUE_REHEARSE_ME: call.wav('me') });
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
  `cue.documents`), its own defaults domain and whisper-server port, all
  wiped after the case, so checkouts can run cases at the same time; the
  speech model is linked in, never copied, and so are the speaker models
  once they are downloaded (until then Cue downloads them on first use into
  the checkout's e2e cache, `CUE_SPEAKER_MODELS`); the calendar and the apps
  using the microphone are read from the case's own files, never from the
  Mac. `cue.path(…)` is a path in the case's folder, `cue.save(name, text)`
  writes a file there, `cue.project(name, settings)` makes a project by hand,
  `cue.apiKey(service, key?)` saves a provider's key where Cue keeps it under
  `CUE_HOME` (`cue.keysFile`): the stand-in's, the one given, or with
  `--real-…` the real one from the keychain (removed when the case ends);
- driving Cue: `cue.defaults(key, value)` (typed by the value: string, bool,
  number or array), `cue.launch({ VAR: 'value' })`, `cue.stop()`,
  `cue.alive()`, `cue.pid`, `cue.cli(…args)` (command-line modes),
  `cue.control(command)` (what a click would do, through `CUE_CONTROL`), `cue.calendar([events])`
  (with times from `minutesFromNow(n)` and `tomorrowAt('HH:MM')`),
  `cue.micApps(…bundleIds)` (who is on the microphone now; none when the call
  app lets go), `cue.whisperCliSpy(seconds)` (a `whisper-cli` for
  `CUE_WHISPER_CLI` that notes how Cue ran it — arguments, priority —
  optionally takes longer, and runs the real one);
- waiting and reading what Cue did: `cue.waitFor(what, seconds, check)`,
  `cue.waitLog(regex, seconds)`, `cue.sessionLog()`, `cue.logCount(regex)`,
  `cue.readyNotes()`, `cue.findNotes()`, `cue.claudeRequests(kind)` (what Cue
  sent the fake claude, or the Anthropic API's stand-in), `cue.serviceRequests(kind)`
  (how Cue called the cloud stand-ins: model, key, caching, Deepgram's query,
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
  `needWhisper`, `needWhisperCli`, `needWindowSnapshots`,
  `needOverlaySnapshots`, `needRealClaude`, `needRealAnthropic`,
  `needRealDeepgram`, `needVoice`, `needReachable`.

Look at the existing cases before writing a new one, and keep each case
focused on one user-visible behaviour. Write only TypeScript that Node can
strip: `.ts` in imports, `type` on imports of types, no `enum`, `namespace`
or constructor parameter properties (`tsconfig.json` checks this).

### Test hooks in the app

Hooks are environment variables read at launch; keep them out of normal
code paths and document new ones here and in `README.md` › Testing.

| Variable | Effect |
|---|---|
| `CUE_HOME=dir` | All files under `dir`, settings in the `com.andriishafar.cue.e2e` domain (`apps/mac/Sources/Cue/Storage.swift`), API keys in `dir/Keychain.json` instead of the login keychain (`apps/mac/Sources/Cue/Providers.swift`); windows don't remember their frames (AppKit would keep them in the user's own settings). |
| `CUE_DEFAULTS_DOMAIN=name` | With `CUE_HOME`, keep settings in this defaults domain. |
| `CUE_WHISPER_PORT=n` | Run (or reuse) whisper-server on this port instead of 8178. |
| `CUE_CLAUDE_BIN=path` | Use this binary instead of `claude`. |
| `CUE_ANTHROPIC_URL=url` | Send Anthropic API requests (`ClaudeProvider.anthropicAPI`) here instead of `https://api.anthropic.com`. |
| `CUE_DEEPGRAM_URL=url` | Send Deepgram requests (`SpeechProvider.deepgram`: the key check, live streams over `ws://`, recorded files) here instead of `https://api.deepgram.com`. |
| `CUE_WHISPER_CLI=path` | Run this binary for the second pass over a recording instead of `whisper-cli` (a missing or failing one: the live transcript is kept). |
| `CUE_SPEAKER_MODELS=dir` | Keep the speaker models (FluidAudio's `speaker-diarization/` folder) in `dir` instead of `Application Support/Cue/models` (an empty folder: Home offers the download; a file in the way: Finding speakers fails and the transcript is kept). |
| `CUE_NO_LIVE_AUDIO=1` | Don't open the microphone or call audio. |
| `CUE_REHEARSE_PARTICIPANT=wav` / `CUE_REHEARSE_ME=wav` | Play a file as the call / as your microphone, in real time; a recording gets its audio too (digital silence on the call side is left out, as ScreenCaptureKit delivers nothing while the Mac is silent). |
| `CUE_REHEARSE_RECORD=1` | Record the rehearsal and write its notes. |
| `CUE_SNAPSHOT=png` | Every 2 s, the overlay to `png`, and the dashboard and Settings, when open, to `…-dashboard.png` / `…-settings.png` (whole window, at the display's scale). With Screen Recording access these are the windows' real pixels from ScreenCaptureKit — glass, materials, selection — in the system appearance; without it (CI), or for a window that isn't on screen (the overlay before Start Cue), the app draws the window offscreen instead (layout and text only, light appearance). The session log says which: `📸 Snapshots: window capture (…), in the dark appearance` or `📸 Snapshots: offscreen, … — reason`, and `📸 Overlay: …` when one window differs. The overlay is capturable while this is set. |
| `CUE_SNAPSHOT_METHOD=m` | How `CUE_SNAPSHOT` takes them: `desktop` (the default: each window over the desktop picture alone, so its glass refracts real pixels yet no other window covers it or shows through), `window` (the window alone: the overlay's glass over nothing), `display` (what's on screen behind the window now, other apps included, minus whatever is in front of it) or `offscreen` (the fallback, forced). |
| `CUE_APPEARANCE=light\|dark` | Use this appearance instead of the system's. |
| `CUE_PROJECT=name` | Make this project active at launch, creating it if there is none by that name. |
| `CUE_CONTROL=file` | Run each line appended to `file` as a click would: `new NAME` (New Project), `add PATH` (drop a file on the open project's materials), `start NAME` (Start Cue), `project NAME` (the overlay's project menu), `page home\|upcoming\|NAME\|NAME/answers\|NAME/notes` (show a dashboard page), `ask TEXT` (the Ask field), `timestamp HH:MM:SS` (a timestamp in the open note's transcript: plays its audio from there), `assign EVENT \| PROJECT` (an Upcoming call's project picker, by event title), `notification record\|dismiss` (Record / Not Now on the latest prompt), `rename NAME \| NEW` (a speaker's name clicked and renamed in the open note), `apply LABEL` / `dismiss LABEL` (Apply or ✕ on a name suggestion of the open note), `download speakers` (Download on Home's Speaker models row), `show TEXT` (the overlay's row of the question with TEXT in it), `newest` (the overlay's New Questions button), `prepare` (Prepare Answer on the newest questions waiting for it), `record` (the overlay's record button, or Stop Recording in its timer's menu), `settings general\|account\|providers\|calendar` (Settings on that tab), `provider NAME` (a provider picked in Settings › Providers: `claudeCode`, `anthropicAPI`, `whisper`, `deepgram`), `key anthropic\|deepgram [KEY]` (a key pasted into its field and saved; without one, Remove), `size W H` (the dashboard's edge dragged until it's W × H points, or as small as it goes), `signin` (Sign In on Home) and `signout` (Sign Out in Settings › Account). Until someone is signed in only `signin`, `signout`, `settings`, `page`, `size`, `provider` and `key` do anything (the rest log `⚠︎ Sign in to Cue first (…)`). Notifications then go only to the session log (`🔔 …`), not Notification Center, so no permission is asked. |
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
`🎚 Working audio: …`, `🔁 Improving transcript…`, `✅ Transcript improved: …`
or `⚠︎ Couldn't improve the transcript: …`, `👥 Finding speakers…`,
`✅ Speakers: N …` or `⚠︎ Couldn't tell speakers apart: …`, `✍️ Writing summary…`,
`💡 Suggested name: LABEL → NAME`, `✏️ Renamed “OLD” to “NEW” in …`,
`👥 Speaker models downloaded: … MB`,
`🔑 Signed in to Cue as EMAIL`, `🔑 Signed out of Cue` (Sign Out, or after `⚠︎ Your Cue session ended: …`),
`🔑 Cue access refreshed`, `⚠︎ Not invited: EMAIL`, `⚠︎ Couldn't sign in to Cue: …`, `⚠︎ Sign in to Cue first`,
`📝 Notes ready: …`, `📅 Recording “Title” into Project`, `🔔 Record “Title”?`
for every notification, `⚠︎ Nothing was recorded: …` for every alert,
`🧐 Question judge ready: Claude Haiku` or
`⚠︎ Question judge unavailable (…) — going by question marks`,
`🤖 Claude: PROVIDER` and `🗣 Speech recognition: PROVIDER` at launch and on
every change, `⚠︎ Speech recognition unavailable: …` and
`🗣 Speech recognition ready again: Deepgram`, `📖 Waits while you read the answer in view: …`
and `📖 Shown now that you've paused: …`,
`🔑 Anthropic API key saved in the keychain` or `… removed` — never a key — and so
on), and never rename existing lines without
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
  and the end-to-end suite on GitHub's hosted macOS runner with the speech model and the
  latest Node. That runner can't recognize speech in time, so speech cases
  skip there with the probe's reason (as do overlay or window snapshot cases,
  if the probe finds those unreadable): CI covers the build, the
  command-line modes, the dashboard and the cases that need no speech. **Run the
  whole suite on an authorized remote Mac before merging** and put its summary
  in the PR. Keep CI green; never fake what's missing.
- `.github/workflows/release.yml` runs on every push to `main`: it builds
  `Cue.app`, zips it and publishes a GitHub release `v<version>.<patch>`
  (`<version>` is `CFBundleShortVersionString` in `apps/mac/Resources/Info.plist`,
  bump it for a new minor or major) with `scripts/changelog.sh` as its notes:
  every change on `main` since the previous release, one line each, with a
  merged pull request's own commits listed under it. Write commit subjects and
  pull request titles that read well in that list.
  `scripts/changelog.sh v2.0.0` prints the notes of an earlier release.
