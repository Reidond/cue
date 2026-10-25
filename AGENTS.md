# Working on Cue

Cue is a macOS overlay prompter and call notetaker: SwiftPM executable in
`Sources/Cue`, resources in `Resources/`, built into `build/Cue.app` by
`./scripts/build.sh`. See `README.md` for what it does.

## Testing: end-to-end only — unit tests are prohibited

This rule is strict and has no exceptions.

- **Never write unit tests.** Do not add XCTest or Swift Testing, a
  `testTarget` in `Package.swift`, a `Tests/` folder, `XCTestCase` / `@Test` /
  `#expect`, mocks or fakes of Cue's own types, or code (protocols, injection
  points, `internal` widening) that exists only so a unit test can call it.
  If you find any, delete them.
- **Every change is verified by an end-to-end case** in `tests/e2e/cases/`
  that runs the built `Cue.app` — the app itself, or its command-line modes
  (`--inspect`, `--render`, …) — against real files, real audio, real
  `whisper-server` and real child processes, and checks what a user would see:
  the notes on disk, the audio files, the session log, the rendered windows.
- Stand-ins are allowed only at the outer boundary, never for Cue's own code:
  - the paid external service: `tests/e2e/tools/fake-claude.ts` replaces
    the `claude` CLI (through `CUE_CLAUDE_BIN`) so cases are fast and
    deterministic. Cases that judge Claude's actual writing run against the
    real CLI with `node tests/e2e/run.ts --real-claude`;
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

### Running the cases

The suite is TypeScript run by Node 26 or later, which strips the types
itself: no build step, no transpiler, no runtime packages.

```bash
node tests/e2e/run.ts                  # build the app, then run every case
node tests/e2e/run.ts --no-build 4 5   # the existing build; cases whose name starts with 4 or 5
node tests/e2e/run.ts --real-claude 45 # the real claude CLI instead of the stand-in
node tests/e2e/run.ts --keep           # keep every sandbox (a failed case always keeps its own)
cd tests/e2e && npm ci && npm run typecheck   # tsc --noEmit; run it before you commit
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
speakers, `6x` calendar). It declares one test, whose title says the
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
  writes a file there, `cue.project(name, settings)` makes a project by hand;
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
  sent the fake claude), `cue.dashboardPage(page, regex)` and
  `cue.dashboardShows(regex)` (show a dashboard page and read its snapshot
  into `cue.page`), `cue.snapshotText(png)`; `summaryOf(notes)` (a note's
  summary, without the transcript), `lines`, `countLines` and `matches` (as
  `grep`, `grep -c` and `grep -o` would), `findFiles`, `listDir`;
- audio and screens: `speech(out, voice, text)` and `dialogue(script, out)`
  (multi-voice calls built with `say`: `wav(side)` per side plus `timeline`),
  `silence(out, seconds)` (a call where nobody speaks), `ocr(png)`,
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
  `needOverlaySnapshots`, `needRealClaude`, `needVoice`, `needReachable`.

Look at the existing cases before writing a new one, and keep each case
focused on one user-visible behaviour. Write only TypeScript that Node can
strip: `.ts` in imports, `type` on imports of types, no `enum`, `namespace`
or constructor parameter properties (`tsconfig.json` checks this).

### Test hooks in the app

Hooks are environment variables read at launch; keep them out of normal
code paths and document new ones here and in `README.md` › Testing.

| Variable | Effect |
|---|---|
| `CUE_HOME=dir` | All files under `dir`, settings in the `com.andriishafar.cue.e2e` domain (`Sources/Cue/Storage.swift`). |
| `CUE_DEFAULTS_DOMAIN=name` | With `CUE_HOME`, keep settings in this defaults domain. |
| `CUE_WHISPER_PORT=n` | Run (or reuse) whisper-server on this port instead of 8178. |
| `CUE_CLAUDE_BIN=path` | Use this binary instead of `claude`. |
| `CUE_WHISPER_CLI=path` | Run this binary for the second pass over a recording instead of `whisper-cli` (a missing or failing one: the live transcript is kept). |
| `CUE_SPEAKER_MODELS=dir` | Keep the speaker models (FluidAudio's `speaker-diarization/` folder) in `dir` instead of `Application Support/Cue/models` (an empty folder: Home offers the download; a file in the way: Finding speakers fails and the transcript is kept). |
| `CUE_NO_LIVE_AUDIO=1` | Don't open the microphone or call audio. |
| `CUE_REHEARSE_PARTICIPANT=wav` / `CUE_REHEARSE_ME=wav` | Play a file as the call / as your microphone, in real time; a recording gets its audio too (digital silence on the call side is left out, as ScreenCaptureKit delivers nothing while the Mac is silent). |
| `CUE_REHEARSE_RECORD=1` | Record the rehearsal and write its notes. |
| `CUE_SNAPSHOT=png` | Every 2 s, the overlay to `png`, and the dashboard and Settings, when open, to `…-dashboard.png` / `…-settings.png` (whole window, at the display's scale). With Screen Recording access these are the windows' real pixels from ScreenCaptureKit — glass, materials, selection — in the system appearance; without it (CI), or for a window that isn't on screen (the overlay before Start Cue), the app draws the window offscreen instead (layout and text only, light appearance). The session log says which: `📸 Snapshots: window capture (…), in the dark appearance` or `📸 Snapshots: offscreen, … — reason`, and `📸 Overlay: …` when one window differs. The overlay is capturable while this is set. |
| `CUE_SNAPSHOT_METHOD=m` | How `CUE_SNAPSHOT` takes them: `desktop` (the default: each window over the desktop picture alone, so its glass refracts real pixels yet no other window covers it or shows through), `window` (the window alone: the overlay's glass over nothing), `display` (what's on screen behind the window now, other apps included, minus whatever is in front of it) or `offscreen` (the fallback, forced). |
| `CUE_APPEARANCE=light\|dark` | Use this appearance instead of the system's. |
| `CUE_PROJECT=name` | Make this project active at launch, creating it if there is none by that name. |
| `CUE_CONTROL=file` | Run each line appended to `file` as a click would: `new NAME` (New Project), `add PATH` (drop a file on the open project's materials), `start NAME` (Start Cue), `project NAME` (the overlay's project menu), `page home\|upcoming\|NAME\|NAME/answers\|NAME/notes` (show a dashboard page), `ask TEXT` (the Ask field), `timestamp HH:MM:SS` (a timestamp in the open note's transcript: plays its audio from there), `assign EVENT \| PROJECT` (an Upcoming call's project picker, by event title), `notification record\|dismiss` (Record / Not Now on the latest prompt), `rename NAME \| NEW` (a speaker's name clicked and renamed in the open note), `apply LABEL` / `dismiss LABEL` (Apply or ✕ on a name suggestion of the open note), `download speakers` (Download on Home's Speaker models row). Notifications then go only to the session log (`🔔 …`), not Notification Center, so no permission is asked. |
| `CUE_CALENDAR_EVENTS=file.json` | Read the calendar from this file instead of EventKit (no permission asked), again on every check: a JSON array of `{title, start, end}` (ISO 8601) with optional `id`, `series` (shared by a recurring event's occurrences), `calendar` (name), `url`, `location`, `notes`, `attendees` (names), `recurring`. |
| `CUE_MIC_APPS=file` | The bundle IDs using the microphone right now, one per line, read on every check instead of Core Audio's process list. |
| `CUE_MEETING_TICK=s` / `CUE_MIC_RELEASE=s` | Check for calls every `s` seconds instead of 5; stop a call's recording once the call app has been off the microphone for `s` seconds instead of 60. |
| `CUE_ALLOW_CAPTURE=1` | Let screenshots see the overlay. |
| `CUE_SHOW_SETTINGS=1` | Open Settings at launch. |
| `CUE_BACKGROUND=1` | Stay out of the way of whoever is using the Mac (`cue.launch` sets it for every case): Cue never activates itself or takes keyboard focus, and has no Dock icon, menu bar icon or hot keys; its windows sit behind every other window — just above the desktop picture, under the desktop's icons, in every Space — where `CUE_SNAPSHOT` still captures each one alone (drawn as an inactive app's window). An alert goes only to the session log (`⚠︎ …`) instead of waiting for a click. |

To look at a design you changed, run the app in a sandbox with snapshots on, show the page,
and read the PNGs as images — then the same in the other appearance:

```bash
home=$(mktemp -d)
CUE_HOME=$home CUE_NO_LIVE_AUDIO=1 CUE_SHOW_SETTINGS=1 CUE_APPEARANCE=dark \
  CUE_SNAPSHOT=$home/cue.png CUE_CONTROL=$home/control build/Cue.app/Contents/MacOS/Cue & pid=$!
sleep 3; echo "new Bee talk" >> "$home/control"   # any CUE_CONTROL line: `page home`, `start NAME`, …
sleep 5; ls "$home"/*.png                         # cue.png (overlay), cue-dashboard.png, cue-settings.png
grep 📸 "$home/Application Support/Cue/sessions/"*.md; kill $pid  # then CUE_APPEARANCE=light
```

A case keeps its sandbox, PNGs included, with `node tests/e2e/run.ts --keep PREFIX`. Never commit
snapshots or put them anywhere in the repository.

The session log (`Application Support/Cue/sessions/*.md`) is the app's
progress record and what cases wait on: keep writing a line for every step a
recording goes through (`🎙 Transcript saved: …`, `🔊 Audio saved: …`,
`🎚 Working audio: …`, `🔁 Improving transcript…`, `✅ Transcript improved: …`
or `⚠︎ Couldn't improve the transcript: …`, `👥 Finding speakers…`,
`✅ Speakers: N …` or `⚠︎ Couldn't tell speakers apart: …`, `✍️ Writing summary…`,
`💡 Suggested name: LABEL → NAME`, `✏️ Renamed “OLD” to “NEW” in …`,
`👥 Speaker models downloaded: … MB`,
`📝 Notes ready: …`, `📅 Recording “Title” into Project`, `🔔 Record “Title”?`
for every notification, `⚠︎ Nothing was recorded: …` for every alert, and so
on), and never rename existing lines without
updating the cases.

## Rules for changes

- Never run the app for testing without `CUE_HOME`: it would read and change
  the user's real settings, library and notes (and run migrations on them).
- Build with `./scripts/build.sh` before running cases; the build must be
  warning-free for new code.
- Match the surrounding code: comment density, naming, SwiftUI and HIG idioms
  (standard controls, semantic colours, system Liquid Glass).
- One feature per branch and PR, with its e2e case in the same PR.

## CI and releases

- `.github/workflows/ci.yml` runs on pull requests only: it builds the app
  (new warnings in `Sources/Cue` fail it), type-checks the end-to-end suite
  and runs it on GitHub's hosted macOS runner with the speech model and the
  latest Node. That runner can't recognize speech in time, so speech cases
  skip there with the probe's reason (as do overlay or window snapshot cases,
  if the probe finds those unreadable): CI covers the build, the
  command-line modes, the dashboard and the cases that need no speech. **Run the
  whole suite on a Mac before merging** and put its summary in the PR. Keep CI
  green; never fake what's missing.
- `.github/workflows/release.yml` runs on every push to `main`: it builds
  `Cue.app`, zips it and publishes a GitHub release `v<version>.<patch>`
  (`<version>` is `CFBundleShortVersionString` in `Resources/Info.plist`,
  bump it for a new minor or major) with `scripts/changelog.sh` as its notes:
  every change on `main` since the previous release, one line each, with a
  merged pull request's own commits listed under it. Write commit subjects and
  pull request titles that read well in that list.
  `scripts/changelog.sh v2.0.0` prints the notes of an earlier release.
