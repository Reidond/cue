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
mic ─────────┐                    ┌─ Cue API (Cloudflare): live call
             ├─ audio, 16 kHz ────┤   Deepgram Nova-3 ─ question judge (Haiku) ─┬─ instant: best prepared answer
call audio ──┘ (ScreenCaptureKit) └──────────────────────────────────────────────┴─ Claude (Sonnet, prompt cache kept warm) ─ streamed answer
```

Cue is a client of its own backend, **the Cue plan**: invited people sign in, and the backend does the listening and the answering with the
owner's Anthropic and Deepgram keys. Nothing is installed or configured on the Mac for it — no Claude Code, no API keys, no speech model
for the live call. (`docs/backend.md` is the design.)

- **Materials** are uploaded to your account, which reads them: PDF, Word and the like by Cloudflare's Workers AI, `.pptx` (slides and
  speaker notes, in presentation order) by the API itself. Prepared answers are found as `Q: …` / `A: …` pairs, or a question
  followed by an `Answer:` line, also in speaker notes; a trailing `(Name)` after
  the question records who asked it.
- **Speech recognition** is Deepgram's Nova-3, in the cloud, through the backend: while Cue listens (or records) the Mac streams the
  microphone and the call audio to a live call on the backend, which keeps one Deepgram stream per side with the project's language and
  names and terms, and sends the transcript back as it is said.
- **Who is speaking** comes from the source: the microphone is you, system
  audio is everyone else on the call. In a recording's notes, the people on
  the call are told apart by voice afterwards, on the backend, from Deepgram's
  speaker labels on the recorded call side.
- **Question detection** happens on the backend: a small Claude (Haiku, without
  your materials, so it answers in about a second) reads what the participants
  said each time a line is transcribed and lists the questions in it that are
  for you — not the talk itself, a rhetorical question it answers, small talk or
  remarks about the call. The call then answers them once the participants pause, or
  as soon as you start talking; several asked in one go are answered each on
  its own and shown together. Its prompt is `apps/api/prompts/judge.md`. If the judge
  can't be reached, sentences ending in `?` count instead.
- **Answers** come from Claude Sonnet on the backend, one conversation per call: your materials are cached in its prompt for an hour and
  written into the cache before the first question, and kept warm while the room is quiet. The summaries of recordings are written by the backend's notes Workflow (below).
  The prompt is `apps/api/prompts/prompt.md`.
- **If the connection drops**, the app reconnects to the same call and picks up the events it missed; audio spoken meanwhile is not heard.
- **The overlay** is a set of Liquid Glass elements following Apple's HIG:
  separate floating pieces, no glass on glass, semantic colors, standard
  controls. It floats above full-screen slides, never takes focus and is hidden
  from screen sharing and screenshots.

## Setup

```bash
./apps/mac/scripts/build.sh
open apps/mac/build/Cue.app
```

Cue opens its dashboard. Cue is for invited people: **Home** first shows **Sign In**, with Google or GitHub (the account your invitation
went to; if it isn't on the list, Cue says so), and nothing else works until it succeeds. Cue's backend (`apps/api`, on Cloudflare) does
the signing in, and later the listening, answering and note-taking; **Settings › Account** shows who is signed in, this month's usage,
and Sign Out. Then, on **Home**:

1. Allow **Microphone** and **Screen & System Audio Recording** when macOS
   asks; after granting the second one, quit and reopen Cue. Listening,
   answering and the notes need nothing else on the Mac. The checklist
   shows what is still missing.
2. Click **New Project** (⌘N) and name it.

On the project's page:

3. Describe the **occasion** (one or two sentences), pick the **language** and
   add **names and terms** that recognition should spell right.
4. Drop your **materials** onto the Materials section. They are uploaded to
   your Cue account, which reads them (PDF, Word, PowerPoint with speaker
   notes, Markdown, text), so cleaning up Downloads later doesn't break anything.
   **Prepared Answers** shows the questions and answers it found in them.
5. Press **Start Cue** (⌘↩): the overlay appears and answers from this project.

Your name, text size, the library folder and what Cue does
when a meeting starts are in **Settings** (⌘,). The overlay's top bar shows the current project; click it to
switch project or open the dashboard. Cue also keeps a menu bar item for quick
actions.

### Library

Projects belong to your Cue account: their settings and materials are kept
there, and shown on every Mac or PC you sign in on. The notes of their calls
stay on this Mac for now, in `~/Documents/Cue` (change it in Settings), one
folder per project, so you can open, back up or move them:

```
~/Documents/Cue/
  PhD defense/
    project.json        the account's project this folder is for, and a copy of its settings
    Notes/              2026-10-24 14.05 – Title.md (+ .m4a, the call's audio)
```

The first time you sign in, the projects found in the library (and the
materials they kept in a `Materials/` folder) are uploaded to your account once:
the session log says `📦 Imported N projects from this Mac`.

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

Each question stays in Cue's list: the answer in view on top, then **New** —
questions you haven't had in full yet (still coming, ready, or waiting for
Prepare Answer) — and **Answered** at the bottom, each newest first. While you
have an older one open, or have scrolled down, the list stays where it is: new
questions wait under a **New Question** button at the top until you click it.
While you read the answer in view aloud, a new question waits in **New**, under
it; once you pause for five seconds, the newest comes into view by itself and
the one you read moves to **Answered**. Saying «Thank you for the question» while
the next answer loads holds nothing back.

## Recording calls

Press ⌃⌥R, the record button in Cue's top bar, or **Start Recording** in the menu
bar. While recording, the button turns into a red timer and the menu bar icon
turns red; to stop, choose **Stop Recording** from the timer's menu or press ⌃⌥R
again. The session log notes what started and stopped each recording. When you
stop, Cue saves the transcript right away and opens the
note in the dashboard, where a list shows the steps it goes through next:

1. **Saving audio** — the call's audio goes next to the note (Keep audio),
   and each side of the recording is uploaded to the backend. An upload that
   breaks off is resumed from the parts that already arrived.
2. **Improving transcript** — the live transcript is written phrase by phrase
   and gets words wrong that the rest of the call makes obvious («дотатниці»
   for «до п'ятниці»). The backend's notes Workflow has Deepgram read each
   side's whole recording again, with the project's language and names and
   terms, and its transcript replaces the live one — each line still at the
   moment it was said.
3. **Finding speakers** — everyone on the call shares the call's audio, so
   the backend tells their voices apart in it and gives each line the voice heard
   most while it was said: «Учасник 1», «Учасник 2»… (Participant 1, 2… in
   English); a call with one other person keeps the plain «Учасник».
4. **Writing summary** — Claude suggests names for the people on the call and
   writes the summary.

Each step is retried by the Workflow before it is given up. If one fails for good, the note keeps what it had (the live transcript, say) and the
list stays on the page with the reason; the other steps run all the same. The notes live in your account on the backend (so
another Mac, or the Windows client later, sees them); the audio is deleted from the backend after the retention period
the owner sets (30 days by default), at once with Keep audio off.

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
language in `apps/mac/Resources/lexicons/`). The files open in any Markdown editor (Obsidian, iA Writer, …).

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

The recording itself is made on your Mac. While Cue listens or records, though, the call's audio and your microphone are streamed to
the Cue backend, which has Deepgram write the live transcript, and the transcript goes to Claude for the answers. After a recording,
each side's audio is uploaded to the backend so Deepgram can read it again and Claude can write the notes; the transcript, the
notes and (with Keep audio on) the audio stay in your account, and the audio is deleted after the retention period the owner sets
(30 days by default). Let people know when you record — consent rules vary by place.

Tips:

- **Use headphones.** With speakers the microphone also hears the call.
- **Share a single window** (your slides), not the entire screen. Cue is
  excluded from capture either way, but window sharing is the safe default.
- Each session is saved as Markdown in `~/Library/Application Support/Cue/sessions/`.

### The Cue plan

There is one way to run Cue, and it needs no setup beyond signing in: the backend picks the models (Claude Sonnet for answers and summaries,
Claude Haiku for the question judge, Deepgram Nova-3 for speech) and pays for them, within the monthly limit your account has
(**Settings › Account** shows this month's usage). When the backend can't do something, the overlay's status line says so — speech
recognition unavailable, Claude warming up — and the session log has the same words (`⚠︎ Speech recognition unavailable: …`,
`🗣 Speech recognition ready again: Cue plan`, `🧐 Question judge ready: Claude Haiku`, `⚠︎ Question judge unavailable (…) — going by question marks`).
**Restart Live Call** in the menu bar makes a new call.

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
the types; there is nothing to build to run them, and `pnpm install` is needed
only for the type check):

```bash
node tests/e2e/run.ts                 # build, then run every case
node tests/e2e/run.ts --no-build 1    # only cases whose name starts with 1
node tests/e2e/run.ts --no-app 95-    # the backend's own cases: no app needed, they run on Linux too
pnpm install && vp check              # format, lint and type-check the TypeScript (Vite+)
```

Every case that launches Cue runs against its own copy of the backend (`apps/api` under `cf dev`, local D1) with a stand-in for Google
and GitHub sign-in, and signs in first (see `AGENTS.md` › The backend in a case).

Anthropic and Deepgram have stand-ins too, served from the case itself: they are the upstreams of the case's backend, which holds the
owner's keys (the stand-ins take only the throwaway ones the harness gives it), so the Mac app never talks to either of them.

`pnpm test` in `tests/e2e` is `node run.ts`. A run stays out of your way, so you
can keep working while it goes: each case's Cue has `CUE_BACKGROUND=1`, which
keeps it from ever coming to the front or taking focus, hides its Dock and menu
bar icons, turns off its hot keys, puts its windows behind every other window
(just above the desktop picture, in every Space, where snapshots still capture
them) and writes alerts to the session log instead of showing them.

The same hooks work by hand:

```bash
# Rehearsal: play a recording as the call instead of live audio
CUE_NO_LIVE_AUDIO=1 CUE_REHEARSE_PARTICIPANT=questions.wav apps/mac/build/Cue.app/Contents/MacOS/Cue

# A two-sided rehearsal that is also recorded and summarized
CUE_NO_LIVE_AUDIO=1 CUE_REHEARSE_RECORD=1 CUE_REHEARSE_PARTICIPANT=call.wav CUE_REHEARSE_ME=me.wav \
  apps/mac/build/Cue.app/Contents/MacOS/Cue

# Render a notes file the way the dashboard shows it
apps/mac/build/Cue.app/Contents/MacOS/Cue --render notes.md notes.png
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
  apps/mac/build/Cue.app/Contents/MacOS/Cue    # /tmp/cue-dashboard.png; /tmp/cue.png is captured once Start Cue shows it
```

`CUE_HOME=dir` keeps all files and settings in `dir` (the sign-in's refresh token too, in
`dir/Keychain.json`, instead of the keychain), `CUE_API_URL` points Cue at another backend (the default is `https://api.cue.app`),
`CUE_WEB_AUTH=headless` signs in without the browser sheet (the redirects followed by hand), `CUE_ME_TICK` sets how often (seconds)
Cue reads its account again, `CUE_UPLOAD_PART_BYTES` sets the size of the parts a recording is uploaded in (8 MiB; the backend wants 5 MiB or
more except for the last), `CUE_UPLOAD_BREAK=n` cuts the upload's connection once after `n` parts (to see it resume),
`CUE_PROJECT=name` picks the project at launch, and
`CUE_CONTROL=file` runs each line appended to the file as a click would
(`new NAME`, `add PATH`, `start NAME`, `project NAME`, `page NAME/answers`,
`ask TEXT`, `timestamp 00:00:12`, `assign EVENT | PROJECT`,
`notification record|dismiss`, `rename NAME | NEW`, `apply LABEL`,
`show TEXT`, `newest`, `prepare`, `record`, `settings account`, `signin`, `signout`,
`size 820 700`; see `AGENTS.md`) and keeps notifications in the
session log (`🔔 Record “Title”?`). `CUE_CALENDAR_EVENTS=events.json` reads the
calendar from a JSON file and `CUE_MIC_APPS=file` the bundle IDs using the
microphone from a text file, both again on every check; `CUE_MEETING_TICK` and
`CUE_MIC_RELEASE` shorten the 5 s check and the 60 s wait after a call app lets
go of the microphone. `CUE_ALLOW_CAPTURE=1` lets screenshots see the overlay
(snapshots always can).
`cd apps/mac && swift scripts/make_icon.swift` regenerates the app icon.
