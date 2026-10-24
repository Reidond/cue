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
  - the paid external service: `tests/e2e/tools/fake-claude.swift` replaces
    the `claude` CLI (through `CUE_CLAUDE_BIN`) so cases are fast and
    deterministic. Cases that judge Claude's actual writing run against the
    real CLI with `tests/e2e/run.sh --real-claude`;
  - system sources that need the user's permission or a live person (the
    microphone, call audio, the calendar database, which apps use the
    microphone, the answer to a notification): an environment hook feeds the
    input at the exact point where Cue reads it from the system (as
    `CUE_REHEARSE_*` does for audio), and everything after that point runs
    for real.
- A feature is done when its case passes: `tests/e2e/run.sh` (all cases) or
  `tests/e2e/run.sh 20-` (cases whose name starts with `20-`). Report the
  PASS / FAIL / SKIP summary, with the failing output, in the PR description.
- A case that needs something the machine lacks (the speech model, a voice,
  a permission) calls `skip "reason"`; it never fakes the missing piece.

### Writing a case

Each case is a Bash script, `tests/e2e/cases/NN-name.sh`, numbered by
feature area (`0x` CLI and launch, `1x` prompter and recording, `2x`
projects and dashboard, `3x` call audio, `4x` second-pass transcript, `5x`
speakers, `6x` calendar). It sources `tests/e2e/lib.sh`, which gives it:

- a sandbox: `CUE_HOME` (a fresh folder holding `Application Support/Cue`
  and `Documents`), its own defaults domain and whisper-server port, all
  wiped after the case, so checkouts can run cases at the same time; the
  speech model is linked in, never copied;
- `cue_defaults KEY TYPE VALUE`, `cue_launch [VAR=value …]`, `cue_stop`,
  `cue_cli ARGS…` (command-line modes), `cue_control COMMAND…` (what a click
  would do, through `CUE_CONTROL`);
- `wait_for "what" SECONDS command…`, `wait_log PATTERN SECONDS`,
  `session_log`, `find_notes`;
- `speech OUT.wav VOICE "text"` and `dialogue SCRIPT OUTDIR` (multi-voice
  calls built with `say`, one WAV per side plus `timeline.tsv`), `ocr PNG`;
- `assert_file`, `assert_contains`, `assert_not_contains`, `assert_eq`,
  `fail`, `skip`, and `need_whisper`, `need_real_claude`, `need_voice`.

Look at the existing cases before writing a new one, and keep each case
focused on one user-visible behaviour.

### Test hooks in the app

Hooks are environment variables read at launch; keep them out of normal
code paths and document new ones here and in `README.md` › Testing.

| Variable | Effect |
|---|---|
| `CUE_HOME=dir` | All files under `dir`, settings in the `com.andriishafar.cue.e2e` domain (`Sources/Cue/Storage.swift`). |
| `CUE_DEFAULTS_DOMAIN=name` | With `CUE_HOME`, keep settings in this defaults domain. |
| `CUE_WHISPER_PORT=n` | Run (or reuse) whisper-server on this port instead of 8178. |
| `CUE_CLAUDE_BIN=path` | Use this binary instead of `claude`. |
| `CUE_NO_LIVE_AUDIO=1` | Don't open the microphone or call audio. |
| `CUE_REHEARSE_PARTICIPANT=wav` / `CUE_REHEARSE_ME=wav` | Play a file as the call / as your microphone. |
| `CUE_REHEARSE_RECORD=1` | Record the rehearsal and write its notes. |
| `CUE_SNAPSHOT=png` | Render the overlay to `png` every 2 s, and the dashboard and Settings, when open, to `…-dashboard.png` / `…-settings.png` (whole window, light appearance). |
| `CUE_PROJECT=name` | Make this project active at launch, creating it if there is none by that name. |
| `CUE_CONTROL=file` | Run each line appended to `file` as a click would: `new NAME` (New Project), `add PATH` (drop a file on the open project's materials), `start NAME` (Start Cue), `project NAME` (the overlay's project menu), `page home\|upcoming\|NAME\|NAME/answers\|NAME/notes` (show a dashboard page), `ask TEXT` (the Ask field). |
| `CUE_ALLOW_CAPTURE=1` | Let screenshots see the overlay. |
| `CUE_SHOW_SETTINGS=1` | Open Settings at launch. |

The session log (`Application Support/Cue/sessions/*.md`) is the app's
progress record and what cases wait on: keep writing a line for every step a
recording goes through (`🎙 Transcript saved: …`, `📝 Notes ready: …`, and so
on), and never rename existing lines without updating the cases.

## Rules for changes

- Never run the app for testing without `CUE_HOME`: it would read and change
  the user's real settings, library and notes (and run migrations on them).
- Build with `./scripts/build.sh` before running cases; the build must be
  warning-free for new code.
- Match the surrounding code: comment density, naming, SwiftUI and HIG idioms
  (standard controls, semantic colours, system Liquid Glass).
- One feature per branch and PR, with its e2e case in the same PR.
