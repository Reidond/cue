# Cue

A floating macOS prompter and call notetaker for talks, defenses, interviews
and meetings. Cue listens to your microphone and to the call (Google Meet, Zoom,
Teams — any app), notices when someone asks you a question and shows what to
say: an instant opener, then a one-line answer within ~2 s, then a few short
points with numbers and where they come from.

It also records calls: press ⌃⌥R and Cue writes Markdown notes with a summary,
key points, decisions, action items and the full timestamped transcript, and
keeps the call's audio next to them.

Everything is organised in **projects** — one per talk, course or series of
calls. A project holds the occasion, the language, names and terms, your
materials and the notes of its calls. Answers are grounded in the materials of
the current project: drop in PDFs, PowerPoint decks, Word documents or
Markdown notes; Cue reads them itself and also picks up any prepared questions
and answers it finds in them.

## How it works

```
mic ─────────┐                                   ┌─ instant: best prepared answer (offline match)
             ├─ VAD ─ whisper.cpp (local) ─ question detector ─┤
call audio ──┘   (ScreenCaptureKit)                            └─ Claude (warm Claude Code session) ─ streamed answer
```

- **Materials** are read natively: PDFKit for PDF, the system `unzip` plus an
  XML parser for `.pptx` (slides and speaker notes, in presentation order) and
  `.docx`. Prepared answers are found as `Q: …` / `A: …` pairs, or a question
  followed by an `Answer:` line, also in speaker notes; a trailing `(Name)` after
  the question records who asked it.
- **Speech recognition** runs on your Mac with `whisper-server` and the
  `large-v3-turbo` model (~1 s for a 10 s phrase on Apple silicon).
- **Who is speaking** comes from the source: the microphone is you, system
  audio is everyone else on the call. In a recording's notes, the people on
  the call are told apart by voice afterwards, on your Mac, with
  [FluidAudio](https://github.com/FluidInference/FluidAudio)'s offline
  speaker diarization.
- **Question detection** fires once the participants pause, or as soon as you
  start talking, after they asked something: a sentence ending in `?` that is
  more than a tag ("Right?"), or one opening with a request ("Could you
  explain…"). Talk without a question, and a question the speaker answers at
  length themselves, gets no answer. Several questions asked in one go are
  answered each on its own and shown together. Cues per language live in
  `Resources/lexicons/`.
- **Answers** come from one long-lived Claude Code session (`claude -p` with
  stream-json), using your Claude Code login — no API key. The session is warmed
  up at launch, and your materials stay in Claude's prompt cache.
- **The overlay** is a set of Liquid Glass elements following Apple's HIG:
  separate floating pieces, no glass on glass, semantic colors, standard
  controls. It floats above full-screen slides, never takes focus and is hidden
  from screen sharing and screenshots.

## Setup

```bash
brew install whisper-cpp
./scripts/build.sh
open build/Cue.app
```

Cue opens its dashboard. On **Home**:

1. **Download** the speech model (1.6 GB, once) and the speaker models
   (22 MB; otherwise the first recording downloads them), and allow **Microphone** and
   **Screen & System Audio Recording** when macOS asks; after granting the
   second one, quit and reopen Cue. The checklist shows what is still missing.
   Claude Code must be installed and signed in (`claude` in Terminal once).
2. Click **New Project** (⌘N) and name it.

On the project's page:

3. Describe the **occasion** (one or two sentences), pick the **language** and
   add **names and terms** that recognition should spell right.
4. Drop your **materials** onto the Materials section. They are copied into
   the project, so cleaning up Downloads later doesn't break anything.
   **Prepared Answers** shows the questions and answers Cue found in them.
5. Press **Start Cue** (⌘↩): the overlay appears and answers from this project.

Your name, the Claude model, text size, the library folder and what Cue does
when a meeting starts are in **Settings** (⌘,). The overlay's top bar shows the current project; click it to
switch project or open the dashboard. Cue also keeps a menu bar item for quick
actions.

### Library

Projects live in `~/Documents/Cue` (change it in Settings), one folder each,
so you can open, back up or move them:

```
~/Documents/Cue/
  PhD defense/
    project.json        name, occasion, language, names & terms, created, last used
    Materials/          copies of the files you added
    Notes/              2026-10-24 14.05 – Title.md (+ .m4a, the call's audio)
```

When you upgrade from a version without projects, your talk settings and
materials become the project **My project** (rename it from its context menu)
and your notes move from `~/Documents/Cue Recordings` into its `Notes/`.

## During the talk

| Shortcut | Action |
|---|---|
| ⌃⌥⏎ | Answer now (what's being said, or the last line) |
| ⌃⌥R | Start or stop recording the call |
| ⌃⌥H | Show or hide Cue |
| ⌃⌥A | Toggle automatic answers (off, questions are listed for **Prepare Answer**) |
| ⌃⌥← / ⌃⌥→ | Previous / next answer |
| ⌃⌥↑ / ⌃⌥↓ | Text size |

Click any transcript line to get an answer for it, or type a question into the
field at the bottom. Drag the top bar to move Cue.

Each question stays in Cue's list, newest on top. While you have an older one
open, or have scrolled down, the list stays where it is: new questions wait
under a **New Question** button at the top until you click it.

## Recording calls

Press ⌃⌥R, the record button in Cue's top bar, or **Start Recording** in the menu
bar. While recording, the button turns into a red timer and the menu bar icon
turns red. When you stop, Cue saves the transcript right away and opens the
note in the dashboard, where a list shows the steps it goes through next:

1. **Saving audio** — the call's audio goes next to the note.
2. **Improving transcript** — the live transcript is written phrase by phrase
   and gets words wrong that the rest of the call makes obvious («дотатниці»
   for «до п'ятниці»). Whisper now reads each side's whole recording again,
   with beam search and the project's language, occasion and names and terms,
   and its transcript replaces the live one — each line still at the moment it
   was said. This takes about 6 minutes per hour of call on an M2 Pro, and runs
   at background priority, so a call you start meanwhile isn't slowed down.
3. **Finding speakers** — everyone on the call shares the call's audio, so
   Cue tells their voices apart in it and gives each line the voice heard
   most while it was said: «Учасник 1», «Учасник 2»… (Participant 1, 2… in
   English); a call with one other person keeps the plain «Учасник». This
   takes about 20 seconds per hour of call on an M2 Pro.
4. **Writing summary** — Claude's summary streams in as it is written.

If a step fails, the note keeps what it had (the live transcript, say) and the
list stays on the page with the reason; the other steps run all the same.

Notes go into the current project's `Notes/` folder (a recording made before
any project exists goes into **Meetings**), as plain Markdown files named
`2026-10-24 14.05 – Title.md`:

```markdown
---
title: "Weekly sync with the design team"
date: 2026-10-24T11:05:00Z
duration: 42 min
participants: Andrii, Participant 1, Participant 2
project: "PhD defense"
audio: "2026-10-24 14.05 – Weekly sync with the design team.m4a"
---

# Weekly sync with the design team

## Summary
## Key points
## Decisions
## Action items
- [ ] Owner: task
## Questions and answers
## Open questions

<!-- transcript -->
## Transcript

**00:00:12 · Andrii**
…
```

The summary and its headings are written in the language of the call, with
the names and terms spelled the way the project has them. It is about the
conversation only: Claude is told never to comment on the transcript or on
speech recognition, and remarks like «(у транскрипті — „дотатниці“…)» that slip
through anyway are dropped (the words that give them away are listed per
language in `Resources/lexicons/`). Use **Summarize Again** on the note to
regenerate it; the transcript is kept as is. The files open in any Markdown editor (Obsidian, iA Writer, …).

Click a speaker's name in the transcript to rename them: Cue replaces the name
everywhere in the note — the transcript, the summary, the title (and so the
file names) and `participants:`. Where the call makes it clear who someone is
(«Дякую, Олено», or a calendar invitation), Claude suggests a name, and the
note shows it as a chip — **Учасник 2 → Олена Мулеса?** — with **Apply**. The
suggestions are kept in the front matter until you apply or dismiss them:

```markdown
participants: Andrii, Participant 1, Participant 2
suggestions: {"Participant 2": "Olena Mulesa"}
```

The call's audio — your microphone and the call mixed, about 15 MB per hour —
is saved next to the note under the same name (`.m4a`, AAC) and renamed or
moved to the Trash with it. An open note has a player on top (play/pause, a
scrubber, a speed menu: 1× / 1.5× / 2×), and clicking a timestamp in the transcript plays
from that moment. Turn off **Keep audio** in Settings to keep text only. While
a note is being processed, each side is also kept on its own in
`~/Library/Application Support/Cue/recordings/`, and deleted once the notes are
ready.

Recording is local: speech recognition runs on your Mac and only the transcript
is sent to Claude for the summary; the audio never leaves your Mac. Let people
know when you record — consent rules vary by place.

Tips:

- **Use headphones.** With speakers the microphone also hears the call.
- **Share a single window** (your slides), not the entire screen. Cue is
  excluded from capture either way, but window sharing is the safe default.
- **Sonnet** gives noticeably more careful answers; **Haiku** is about a second
  faster to finish. Switch in Settings.
- Each session is saved as Markdown in `~/Library/Application Support/Cue/sessions/`.

### Meetings from your calendar

Allow **Calendar access** (Home, or **Upcoming** in the sidebar). **Upcoming**
lists today's and tomorrow's events that have a Google Meet, Zoom, Teams or
Webex link (in the event's URL, location or notes), each with a link to join
the call and the project its notes go to: **Meetings** unless you pick another one. The
pick is remembered for every occurrence of a recurring meeting.

When a call starts — from five minutes before the event until it ends — and a
call app is using the microphone (Chrome, Safari, Arc, Edge, Zoom, Teams, Webex,
FaceTime or Slack), Cue asks in a notification: **Record “Weekly sync”?** with
**Record** and **Not Now**. Clicking the notification also records; after Not
Now it doesn't ask about that meeting again. A call in Zoom, Teams, Webex,
FaceTime or Slack that isn't in your calendar is offered too, and goes to
**Meetings**. In **Settings › Calendar** choose what happens when a meeting
starts — **Ask** (default), **Record automatically** or **Do nothing** — and
which calendars Cue looks at.

A meeting's note is named after the event and lists who was invited, which also
helps Claude with names in the summary:

```markdown
title: "Weekly sync"
project: "Meetings"
event: "Weekly sync"
attendees: ["Olena Mulesa", "Petro Ivanenko"]
```

When the call app has let go of the microphone for a minute, Cue stops,
writes the notes and tells you in a notification; click it to open them. You
can also record a call in progress from its row in Upcoming.

## Releases

Every change merged into `main` is built and published on the
[Releases](https://github.com/Reidond/cue/releases) page with a changelog. The
builds are signed ad hoc, not notarized: the first time, right-click Cue.app ›
**Open**.

## Testing

Cue is tested end to end only — no unit tests (see `AGENTS.md`). The cases in
`tests/e2e/cases/` run the built app in a sandbox (`CUE_HOME`), feed it speech
made with macOS voices, and check the notes, audio, session log and rendered
windows. They are TypeScript, run by Node 26 or later as they are (Node strips
the types; there is nothing to build or install to run them):

```bash
node tests/e2e/run.ts                 # build, then run every case
node tests/e2e/run.ts --no-build 1    # only cases whose name starts with 1
node tests/e2e/run.ts --real-claude   # use the real Claude Code instead of the stand-in
cd tests/e2e && npm ci && npm run typecheck   # type-check the cases and the harness
```

`npm test` in `tests/e2e` is `node run.ts`. A run stays out of your way, so you
can keep working while it goes: each case's Cue has `CUE_BACKGROUND=1`, which
keeps it from ever coming to the front or taking focus, hides its Dock and menu
bar icons, turns off its hot keys, puts its windows behind every other window
(just above the desktop picture, in every Space, where snapshots still capture
them) and writes alerts to the session log instead of showing them.

The same hooks work by hand:

```bash
# What Cue extracts from files, including prepared answers
build/Cue.app/Contents/MacOS/Cue --inspect slides.pptx answers.docx

# Rehearsal: play a recording as the call instead of live audio
CUE_NO_LIVE_AUDIO=1 CUE_REHEARSE_PARTICIPANT=questions.wav build/Cue.app/Contents/MacOS/Cue

# A two-sided rehearsal that is also recorded and summarized
CUE_NO_LIVE_AUDIO=1 CUE_REHEARSE_RECORD=1 CUE_REHEARSE_PARTICIPANT=call.wav CUE_REHEARSE_ME=me.wav \
  build/Cue.app/Contents/MacOS/Cue

# Render a notes file the way the dashboard shows it
build/Cue.app/Contents/MacOS/Cue --render notes.md notes.png
```

`CUE_SNAPSHOT=/tmp/cue.png` writes the windows to PNGs every 2 s — the overlay
to `cue.png`, the dashboard to `cue-dashboard.png`, Settings to
`cue-settings.png`. With Screen Recording access they are the windows' real
pixels, captured with ScreenCaptureKit — Liquid Glass, materials, selection and
all, in the system appearance (`CUE_APPEARANCE=light` or `dark` picks one) — each
window over the desktop picture alone, so nothing else covers it or shows
through. `CUE_SNAPSHOT_METHOD=window` captures the window alone (the overlay's
glass then has nothing behind it), `display` with whatever is on screen behind
it, and `offscreen` forces the fallback used without the permission (on CI) and
for a window that isn't on screen: the app draws it itself, layout and text only,
in the light appearance. The session log says which (`📸 Snapshots: …`). To look
at the design, launch with `CUE_HOME` and `CUE_SNAPSHOT`, show a page with
`CUE_CONTROL`, and open the PNGs; then the same with the other appearance:

```bash
CUE_HOME=$(mktemp -d) CUE_NO_LIVE_AUDIO=1 CUE_APPEARANCE=dark CUE_SNAPSHOT=/tmp/cue.png \
  build/Cue.app/Contents/MacOS/Cue    # /tmp/cue-dashboard.png; /tmp/cue.png is captured once Start Cue shows it
```

`CUE_HOME=dir` keeps all files and settings in `dir`, `CUE_CLAUDE_BIN` swaps in
another `claude` and `CUE_WHISPER_CLI` another `whisper-cli` for the second
pass, `CUE_SPEAKER_MODELS=dir` keeps the speaker models in `dir`,
`CUE_PROJECT=name` picks the project at launch, and
`CUE_CONTROL=file` runs each line appended to the file as a click would
(`new NAME`, `add PATH`, `start NAME`, `project NAME`, `page NAME/answers`,
`ask TEXT`, `timestamp 00:00:12`, `assign EVENT | PROJECT`,
`notification record|dismiss`, `rename NAME | NEW`, `apply LABEL`,
`download speakers`, `show TEXT`, `newest`, `prepare`; see `AGENTS.md`) and keeps notifications in the
session log (`🔔 Record “Title”?`). `CUE_CALENDAR_EVENTS=events.json` reads the
calendar from a JSON file and `CUE_MIC_APPS=file` the bundle IDs using the
microphone from a text file, both again on every check; `CUE_MEETING_TICK` and
`CUE_MIC_RELEASE` shorten the 5 s check and the 60 s wait after a call app lets
go of the microphone. `CUE_ALLOW_CAPTURE=1` lets screenshots see the overlay
(snapshots always can).
`swift scripts/make_icon.swift` regenerates the app icon.
