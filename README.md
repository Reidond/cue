# Seminar Overlay

A floating macOS overlay that listens to the seminar (your microphone and the
Google Meet audio), notices when a participant asks a question, and shows what
to say: an instant opener, then a one-line answer from Claude within ~1 s, then
2–4 short points with numbers and the dissertation page.

Everything is grounded in your own materials: the slides with speaker notes,
the prepared Q&A document and the dissertation text (~170k tokens, kept in
Claude's prompt cache).

## How it works

```
mic ─────────┐                                  ┌─ instant: best prepared answer (offline match)
             ├─ VAD ─ whisper.cpp (local) ─ question detector ─┤
Meet audio ──┘   (ScreenCaptureKit)                            └─ Claude (claude -p, warm session) ─ streamed answer
```

- **Speech recognition** runs locally: `whisper-server` with `large-v3-turbo`,
  ~1 s for a 10 s phrase on an M2 Pro. Vocabulary hints (names, terms) live in
  `Resources/whisper_prompt.txt`.
- **Who is speaking** is known from the source: the microphone is you, system
  audio is the other Meet participants.
- **Question detection**: a participant line with a question cue (`?`, «чому»,
  «поясніть», …) fires after ~1.8 s of quiet, or as soon as you start talking.
  Cues live in `Resources/lexicon.json`.
- **Answers** come from a single long-lived Claude Code session
  (`claude -p --input-format stream-json`), using your Claude Code login — no
  API key. The session is warmed up at launch so the first question is fast.
- The window is **hidden from screen sharing** and screenshots
  (`NSWindow.sharingType = .none`), floats above full-screen PowerPoint and
  never takes focus from it.

## Setup

```bash
brew install whisper-cpp
mkdir -p ~/Library/Application\ Support/SeminarOverlay/models
curl -L -o ~/Library/Application\ Support/SeminarOverlay/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

Build the knowledge base from your materials (rerun whenever they change), then the app:

```bash
uv run scripts/prepare_knowledge.py "Семінар Шафар v4.pptx" Shafar_Pytannia_ta_vidpovidi.docx "Шафар_PhD _v5.pdf"
./scripts/build.sh
open build/SeminarOverlay.app
```

On first launch macOS asks for **Microphone** and **Screen & System Audio
Recording** access. After granting the second one, quit (menu-bar 🎓 → Quit)
and open the app again.

## During the seminar

| Shortcut | Action |
|---|---|
| ⌃⌥⏎ | Answer now (what participants are saying, or their last line) |
| ⌃⌥H | Show / hide the overlay |
| ⌃⌥A | Toggle automatic answers |
| ⌃⌥← / ⌃⌥→ | Previous / next answer |
| ⌃⌥↑ / ⌃⌥↓ | Text size |

You can also click any transcript line to get an answer for it, or type a
question into the field at the bottom. The gear menu switches between Haiku
(faster) and Sonnet (more precise) and enables questions from the microphone
for people asking in the room.

Tips:

- **Use headphones.** With speakers the microphone also hears Meet.
- **In Meet, share the PowerPoint window**, not the entire screen. The overlay
  is excluded from capture either way, but window sharing is the safe default.
- Each session is saved as Markdown in
  `~/Library/Application Support/SeminarOverlay/sessions/`.

## Rehearsal

Play recorded questions into the pipeline instead of live audio:

```bash
SEMINAR_NO_LIVE_AUDIO=1 SEMINAR_REHEARSE_PARTICIPANT=questions.wav \
  build/SeminarOverlay.app/Contents/MacOS/SeminarOverlay
```

`SEMINAR_ALLOW_CAPTURE=1` makes the window visible to screenshots for testing.
