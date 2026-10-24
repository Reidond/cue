# Cue

A floating macOS prompter for talks, defenses and interviews. Cue listens to
your microphone and to the call (Google Meet, Zoom, Teams — any app), notices
when someone asks you a question and shows what to say: an instant opener,
then a one-line answer within ~2 s, then a few short points with numbers and
where they come from.

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
| ⌃⌥H | Show or hide Cue |
| ⌃⌥A | Toggle automatic answers |
| ⌃⌥← / ⌃⌥→ | Previous / next answer |
| ⌃⌥↑ / ⌃⌥↓ | Text size |

Click any transcript line to get an answer for it, or type a question into the
field at the bottom. Drag the top bar to move Cue.

Tips:

- **Use headphones.** With speakers the microphone also hears the call.
- **Share a single window** (your slides), not the entire screen. Cue is
  excluded from capture either way, but window sharing is the safe default.
- **Sonnet** gives noticeably more careful answers; **Haiku** is about a second
  faster to finish. Switch in Settings.
- Each session is saved as Markdown in `~/Library/Application Support/Cue/sessions/`.

## Testing

```bash
# What Cue extracts from files, including prepared answers
build/Cue.app/Contents/MacOS/Cue --inspect slides.pptx answers.docx

# Rehearsal: play a recording as the call instead of live audio
CUE_NO_LIVE_AUDIO=1 CUE_REHEARSE_PARTICIPANT=questions.wav build/Cue.app/Contents/MacOS/Cue
```

`CUE_SNAPSHOT=/tmp/cue.png` renders the windows to PNGs every 2 s (layout and
text only — the glass is composited by the window server), and
`CUE_ALLOW_CAPTURE=1` lets screenshots see the overlay. `swift scripts/make_icon.swift`
regenerates the app icon.
