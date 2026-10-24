# Cue

A floating macOS prompter and call notetaker for talks, defenses, interviews
and meetings. Cue listens to your microphone and to the call (Google Meet, Zoom,
Teams — any app), notices when someone asks you a question and shows what to
say: an instant opener, then a one-line answer within ~2 s, then a few short
points with numbers and where they come from.

It also records calls: press ⌃⌥R and Cue writes Markdown notes with a summary,
key points, decisions, action items and the full timestamped transcript, and
shows them in its Recordings window.

Answers are grounded in your own materials. Drop in PDFs, PowerPoint decks,
Word documents or Markdown notes; Cue reads them itself and also picks up any
prepared questions and answers it finds in them.

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
  audio is everyone else on the call.
- **Question detection** fires after a participant line with a question cue
  (`?` or words like "why", "explain") once they pause, or as soon as you start
  talking. Cues per language live in `Resources/lexicons/`.
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

Then in **Settings** (menu bar ⟶ Cue ⟶ Settings…):

1. **Download** the speech model (1.6 GB, once).
2. Add your **materials** — drag files onto the Materials section.
3. Set your **name**, the **occasion** (one or two sentences) and the
   **language**. Add **names and terms** that recognition should spell right.
4. Allow **Microphone** and **Screen & System Audio Recording** when macOS
   asks; after granting the second one, quit and reopen Cue.

The Setup section shows what is missing. Claude Code must be installed and
signed in (`claude` in Terminal once).

## During the talk

| Shortcut | Action |
|---|---|
| ⌃⌥⏎ | Answer now (what's being said, or the last line) |
| ⌃⌥R | Start or stop recording the call |
| ⌃⌥H | Show or hide Cue |
| ⌃⌥A | Toggle automatic answers |
| ⌃⌥← / ⌃⌥→ | Previous / next answer |
| ⌃⌥↑ / ⌃⌥↓ | Text size |

Click any transcript line to get an answer for it, or type a question into the
field at the bottom. Drag the top bar to move Cue.

## Recording calls

Press ⌃⌥R, the record button in Cue's top bar, or **Start Recording** in the menu
bar. While recording, the button turns into a red timer and the menu bar icon
turns red. When you stop, Cue saves the transcript right away, opens
**Recordings** and streams the summary in as Claude writes it.

Notes are plain Markdown files in `~/Documents/Cue Recordings` (change the
folder in Settings), named `2026-10-24 14.05 – Title.md`:

```markdown
---
title: "Weekly sync with the design team"
date: 2026-10-24T11:05:00Z
duration: 42 min
participants: Andrii, Participant
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

The summary and its headings are written in the language of the call. Use
**Summarize Again** in the Recordings window to regenerate it; the transcript
is kept as is. The files open in any Markdown editor (Obsidian, iA Writer, …).

Recording is local: speech recognition runs on your Mac and only the transcript
is sent to Claude for the summary. No audio is kept. Let people know when you
record — consent rules vary by place.

Tips:

- **Use headphones.** With speakers the microphone also hears the call.
- **Share a single window** (your slides), not the entire screen. Cue is
  excluded from capture either way, but window sharing is the safe default.
- **Sonnet** gives noticeably more careful answers; **Haiku** is about a second
  faster to finish. Switch in Settings.
- Each session is saved as Markdown in `~/Library/Application Support/Cue/sessions/`.

## Testing

Cue is tested end to end only — no unit tests (see `AGENTS.md`). The cases in
`tests/e2e/cases/` run the built app in a sandbox (`CUE_HOME`), feed it speech
made with macOS voices, and check the notes, audio, session log and rendered
windows:

```bash
tests/e2e/run.sh                 # build, then run every case
tests/e2e/run.sh --no-build 1    # only cases whose name starts with 1
tests/e2e/run.sh --real-claude   # use the real Claude Code instead of the stand-in
```

The same hooks work by hand:

```bash
# What Cue extracts from files, including prepared answers
build/Cue.app/Contents/MacOS/Cue --inspect slides.pptx answers.docx

# Rehearsal: play a recording as the call instead of live audio
CUE_NO_LIVE_AUDIO=1 CUE_REHEARSE_PARTICIPANT=questions.wav build/Cue.app/Contents/MacOS/Cue

# A two-sided rehearsal that is also recorded and summarized
CUE_NO_LIVE_AUDIO=1 CUE_REHEARSE_RECORD=1 CUE_REHEARSE_PARTICIPANT=call.wav CUE_REHEARSE_ME=me.wav \
  build/Cue.app/Contents/MacOS/Cue

# Render a notes file the way the Recordings window does
build/Cue.app/Contents/MacOS/Cue --render notes.md notes.png
```

`CUE_SNAPSHOT=/tmp/cue.png` renders the windows to PNGs every 2 s (layout and
text only — the glass is composited by the window server, so the overlay is
rendered from its view), `CUE_HOME=dir` keeps all files and settings in `dir`,
`CUE_CLAUDE_BIN` swaps in another `claude`, and `CUE_ALLOW_CAPTURE=1` lets
screenshots see the overlay. `swift scripts/make_icon.swift`
regenerates the app icon.
