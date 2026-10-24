# Cue: projects dashboard, call audio, better transcripts, speakers, calendar

## Context

Cue (`~/src/cue`) is a macOS overlay prompter that also records calls into
Markdown notes. Its current limits, which the user wants fixed:

1. No audio is kept, only text.
2. Everyone on the call is one "Participant".
3. Claude sometimes comments on misheard words in the summary
   («у транскрипті — „дотатниці“, ймовірно…»), because the live transcript is
   cut into short phrases and has errors.
4. Recording never starts by itself; there is no calendar awareness.
5. (new) Setup lives in a Settings form. The user wants a dashboard that opens
   first: create a project, add its materials, start the overlay for that
   project — and a home for the features above.

Facts checked during research:
- A whole-file Whisper pass on the test call fixed «дотатниці» → «до пятниці»
  and «у згодженості» → «узгодженості»; 51 s of audio took 6.8 s, so about
  5 min per hour on this M2 Pro.
- FluidAudio v0.17.7 (Apache 2.0, macOS 14+) has offline diarization:
  `OfflineDiarizerManager(config:)`, `prepareModels()`,
  `process(audio: [Float])` → segments with `speakerId`, `startTimeSeconds`,
  `endTimeSeconds`. SwiftPM trait `"Diarizer"` keeps the build small. Models
  download from Hugging Face on first use (size to be measured).
- The macOS 27 SDK has `kAudioHardwarePropertyProcessObjectList`,
  `kAudioProcessPropertyIsRunningInput` and `kAudioProcessPropertyBundleID`,
  so Cue can tell which app is using the microphone. EventKit and
  UserNotifications are available.

## Order

**5 → 1 → 3 → 2 → 4.** The dashboard comes first because it changes the data
model: projects own materials and recordings, and features 1–4 show up in
it. Audio (1) comes before the transcript pass (3) and speakers (2), which
both read the saved audio. Calendar (4) comes last; it only needs a way to
start a recording for a project. Each step ends with a working app and its own
commit.

## Data layout (shared by every step)

Everything lives in a library folder the user can open and back up,
`~/Documents/Cue/` by default:

```
~/Documents/Cue/
  Семінар PhD/                 one folder per project
    project.json               name, occasion, language, names & terms, created, last used
    Materials/                 copies of the files the user added
    Notes/                     2026-10-24 14.05 – Title.md (+ .m4a)
  Meetings/                    default project for calendar recordings
```

- Materials are **copied** in, so a project keeps working after Downloads is
  cleaned up and can be moved to another Mac.
- Global preferences stay in UserDefaults: your name, Claude model, text size,
  library location, summary on/off, calendar behaviour.
- Migration on first launch: today's settings become a project called
  "My project" (name editable), and existing notes in
  `~/Documents/Cue Recordings` move into its `Notes/`.

## 5. Dashboard with projects

**Experience**
- Cue becomes a normal app with a Dock icon and an app menu. The menu bar
  item stays for quick actions.
- Launching Cue opens the dashboard window: `NavigationSplitView`, Liquid Glass
  sidebar and toolbar from the system, following the HIG.
  - Sidebar: **Home**, **Upcoming** (calendar, step 4), then the project list
    with **New Project** (+). Context menu: Rename, Show in Finder, Delete
    (moves to Trash, with a confirmation).
  - **Home**: a checklist card shown until setup is complete (speech model,
    Claude Code, microphone, call audio, calendar), recent notes across
    projects, and a large **New Project** call to action when there are no
    projects yet.
  - **Project page**: header with the name and a prominent **Start Cue**
    button (opens the overlay bound to this project, ⌘↩). Sections:
    - *About the talk*: occasion, language, names & terms.
    - *Materials*: drop zone and file list with per-file summary (slides,
      pages, prepared answers), token total, status while reading.
    - *Prepared answers*: the Q&A pairs found, searchable, so the user can
      check what Cue picked up.
    - *Notes*: this project's recordings; opening one shows the rendered
      Markdown on the right, with the player from step 1.
- The overlay shows the current project's name in its top bar, with a menu to
  switch project or open the dashboard. The record button records into the
  current project.
- The old Settings form becomes a small standard Settings window (⌘,) with
  global preferences only.

**Code**
- New `Project` model and `ProjectStore` (`Sources/Cue/Projects.swift`):
  load/save `project.json`, create/rename/delete, copy materials in, list notes.
- Split `Profile.swift` into global `Preferences` and the active `Project`.
  `AppState` gets `activeProject` and switches knowledge, Whisper vocabulary
  and language when it changes, reusing `rebuildKnowledge()` and
  `applyLanguage()` as they are.
- `RecordingStore` (`Sources/Cue/Recordings.swift`) takes a folder per
  project instead of the global one; front matter gains `project:`.
- New views: `DashboardView`, `HomeView`, `ProjectView`, `PreparedAnswersView`.
  Reuse `MarkdownView`, `MaterialRow` / `SetupRow` (from `SettingsView.swift`)
  and the `RecordingDetail` pieces from `RecordingsView.swift`. The separate
  Recordings window is folded into the dashboard.
- `main.swift`: dashboard window at launch, activation policy `.regular`,
  `Info.plist` drops `LSUIElement`.

**Done when** a new user can create a project, drop files, press Start Cue and
get answers from that project; switching projects changes which materials Cue
answers from; the user's current seminar setup appears as a project after the
upgrade.

## 1. Save call audio

- New `AudioRecorder` (`Sources/Cue/AudioRecorder.swift`) fed by the existing
  `MicCapture` / `SystemAudioCapture` sample callbacks while recording (both
  already deliver 16 kHz mono floats).
  - Writes three files on a background queue: `mic.wav` and `call.wav`
    (16-bit PCM, temporary, used by steps 3 and 2) and the mixed
    `Title.m4a` (AAC, about 15 MB per hour) next to the notes.
  - Mixing places each chunk by its capture time, so the two sides line up
    even when the call is silent and no system audio arrives.
- Front matter gets `audio: Title.m4a`; renaming after the summary and Move to
  Trash handle the audio file too.
- Player at the top of an open note (AVPlayer): play/pause, scrubber,
  1×/1.5×/2×. Clicking a speaker's timestamp in the transcript seeks there —
  `MarkdownView` gets an `onTimestamp` callback for its `.speaker` blocks.
- Preference "Keep audio" (on by default).

**Done when** a recording leaves a playable `.m4a` whose two sides are in sync,
and timestamps in the notes jump to the right moment.

## 3. Second-pass transcript and a cleaner summary

- After Stop the note goes through visible steps: *Saving audio → Improving
  transcript → Finding speakers (step 2) → Writing summary*, shown as a
  progress list on the note page. The live transcript is saved first, so
  nothing is lost if a later step fails.
- Improving transcript: run `whisper-cli` (separate low-priority process, so
  live recognition in a following call isn't blocked) on `mic.wav` and
  `call.wav` with beam search 5, the project's language and names & terms as
  the prompt, and `-ojf` JSON for segment timestamps. Merge both sides by time
  into the transcript, replacing the live one. Reuse `WhisperService.clean`
  for hallucination filtering and `CallTranscript` for turns and offsets.
- Summary prompt (`Summarizer.systemPrompt` in `Recordings.swift`) also gets
  the names & terms, the project's occasion, and the calendar title and
  attendees (step 4), plus an explicit rule with a counter-example: never
  write notes about the transcript or recognition.
- Safety net: drop parenthetical remarks that mention the transcript or
  recognition (words listed per language in the lexicons).

**Done when** the test call's notes say «до п'ятниці» with no remarks about the
transcript, and a one-hour recording finishes processing in about 5–8 minutes.

## 2. Tell speakers apart

- Add FluidAudio (`from: "0.17.7"`, trait `"Diarizer"`) to `Package.swift`.
- After the second pass, run `OfflineDiarizerManager` on `call.wav` only (the
  microphone side is always you). Give each call-side segment the speaker with
  the most time overlap; consecutive segments from one speaker become a turn.
- Labels: «Учасник 1», «Учасник 2»… (localized in the lexicons). One speaker →
  keep the plain participant label. Diarization failure → keep the transcript
  as is and note it in the progress list.
- Naming:
  - The summarizer may suggest names from context ("Дякую, Олено") and from
    calendar attendees. Suggestions show as chips on the note page:
    "Учасник 1 → Олена Мулеса?" with Apply.
  - Rename any speaker by clicking their name; Cue replaces it throughout the
    note.
- Speaker models download on first use, shown in the Home checklist like the
  speech model.

**Done when** a three-voice test call (built with macOS `say` voices) comes out
with three distinct speakers plus you, and renaming a speaker updates the
whole note.

## 4. Calendar: ask to record when a meeting starts

- EventKit with full access (`NSCalendarsFullAccessUsageDescription`); the
  user picks which calendars to watch in Settings.
- **Upcoming** in the sidebar: today's and tomorrow's events that have a
  Meet / Zoom / Teams / Webex link (found in the URL, location or notes), each
  assigned to a project (default "Meetings", remembered per recurring event).
- `MeetingMonitor` checks every 5 s:
  - a watched event is in progress (from 5 min before start to its end), and
  - a known call app uses the microphone (Chrome, Safari, Arc, Edge, Zoom,
    Teams, Webex, FaceTime, Slack), via the Core Audio process list.
  When both are true, a notification asks: **Record “Title”?** with Record /
  Not now. Native call apps without a calendar event also prompt.
- Preference "When a meeting starts": **Ask** (default, as requested) /
  Record automatically / Do nothing.
- Recording from an event uses the event title, attendees (for step 2 naming)
  and the event's project. When the call app releases the microphone for 60 s,
  Cue stops and processes the recording, and a notification says the notes
  are ready.

**Done when** a test event with a Meet link, plus Chrome using the mic, shows
the prompt; Record produces a note titled after the event in its project;
leaving the call stops the recording.

## Verification

- Build after each step with `./scripts/build.sh`; commit per step.
- End-to-end cases only (see `AGENTS.md`): extend the rehearsal hooks —
  `CUE_REHEARSE_PARTICIPANT` / `CUE_REHEARSE_ME` / `CUE_REHEARSE_RECORD` also
  produce the audio files, and a third-voice rehearsal covers diarization.
  Check the notes with `Cue --render notes.md out.png` and the session log.
- Dashboard: offscreen snapshots (`CUE_SNAPSHOT`) cover layout and text; the
  glass look needs a look on screen by the user.
- Live checks that need the user: permissions (microphone, call audio,
  calendar, notifications), a real call end to end, and the calendar prompt.

## Open items to confirm during implementation

- FluidAudio model download size and diarization accuracy on real Ukrainian
  calls (the method is language-independent, but untested here).
- Whether browser mic use + calendar event is a reliable enough signal, or the
  prompt also needs the Meet tab title.
- Notification permission for a development-signed app.
