import { type Static, Type } from '@sinclair/typebox';
import { Channel } from './calls.ts';

// After a call (docs/backend.md › Notes): the recording goes up as a resumable multipart upload, the notes Workflow reads it, and the notes are
// kept on the server. Times in REST bodies are milliseconds since the epoch; times inside a note's transcript are seconds since the recording began.

/**
 * The audio of a recording: each side of the call on its own (16 kHz mono WAV, what the notes Workflow transcribes) and, for playing, both mixed
 * (AAC), which the app only uploads while Keep audio is on.
 */
export const Side = Type.Union([Type.Literal('me'), Type.Literal('others'), Type.Literal('mixed')]);
export type Side = Static<typeof Side>;

/** The smallest part of a multipart upload that is not the last (R2's rule). Clients may send bigger ones. */
export const MIN_PART_BYTES = 5 * 1024 * 1024;

// MARK: Recording upload

/** `…/recording/:side`: which call and side. */
export const RecordingPath = Type.Object({ id: Type.String(), side: Side });

/** `?take=`: the recording's start, milliseconds since the epoch (a call can hold several recordings); `part` on the `PUT`. */
export const TakeQuery = Type.Object({ take: Type.Integer({ minimum: 1 }) });
export const PartQuery = Type.Object({
    take: Type.Integer({ minimum: 1 }),
    part: Type.Integer({ minimum: 1, maximum: 10000 }),
});

export const UploadPart = Type.Object({ partNumber: Type.Integer(), size: Type.Integer() });

/** Where an upload stands; `POST` on the side's path begins it, or (the same call again) says what already arrived. */
export const Upload = Type.Object({
    uploadId: Type.String(),
    side: Side,
    status: Type.Union([Type.Literal('open'), Type.Literal('done')]),
    parts: Type.Array(UploadPart, { description: 'The parts that landed, by number: resume by sending the rest' }),
    size: Type.Union([Type.Integer(), Type.Null()], { description: 'The finished object’s size, once done' }),
});
export type Upload = Static<typeof Upload>;

export const UploadedPart = Type.Object({ partNumber: Type.Integer(), etag: Type.String() });

// MARK: Notes

/** One paragraph of the transcript: consecutive lines of one voice with short pauses between them. */
export const Turn = Type.Object({
    channel: Channel,
    speaker: Type.Union([Type.Integer(), Type.Null()], { description: 'The voice on the call side (1, 2, …) when they were told apart' }),
    label: Type.String({
        description: 'Who the transcript says it is: the user’s name, "Participant", "Participant 2", or a name once renamed',
    }),
    start: Type.Number({ description: 'Seconds since the recording began' }),
    text: Type.String(),
});
export type Turn = Static<typeof Turn>;

export const NoteStepId = Type.Union([
    Type.Literal('transcript'),
    Type.Literal('speakers'),
    Type.Literal('names'),
    Type.Literal('summary'),
]);

/** A step of the Workflow as the note's page lists it. */
export const NoteStep = Type.Object({
    id: NoteStepId,
    title: Type.String({ description: '"Improving transcript", "Finding speakers", "Suggesting names", "Writing summary"' }),
    state: Type.Union([Type.Literal('pending'), Type.Literal('running'), Type.Literal('done'), Type.Literal('failed')]),
    detail: Type.Union([Type.String(), Type.Null()], { description: 'What it found, or why it failed (for people)' }),
});
export type NoteStep = Static<typeof NoteStep>;

export const MeetingDetails = Type.Object({ title: Type.String(), attendees: Type.Array(Type.String()) });

export const Note = Type.Object({
    id: Type.String(),
    callId: Type.Union([Type.String(), Type.Null()], { description: 'Null for a note imported from a Mac’s library' }),
    projectId: Type.Union([Type.String(), Type.Null()]),
    title: Type.String(),
    startedAt: Type.Number(),
    durationSeconds: Type.Number(),
    status: Type.Union([Type.Literal('processing'), Type.Literal('ready')], {
        description: 'ready: the Workflow is over (a step may have failed)',
    }),
    language: Type.String(),
    speaker: Type.String({ description: 'The name of the person who recorded it, the user’s side of the transcript' }),
    meeting: Type.Union([MeetingDetails, Type.Null()]),
    participants: Type.Array(Type.String(), { description: 'The user first, then the labels or names of the others' }),
    summary: Type.String({ description: 'Markdown, without the title and the name suggestions' }),
    transcriptHeading: Type.String({ description: '"Transcript", «Транскрипт»: the language’s heading for it' }),
    transcript: Type.Array(Turn),
    suggestions: Type.Record(Type.String(), Type.String(), {
        description: 'Names the summary found for labels: {"Participant 1": "Olena Mulesa"}',
    }),
    steps: Type.Array(NoteStep),
    audio: Type.Array(Side, { description: 'The sides still in storage (retention deletes them)' }),
    createdAt: Type.Number(),
});
export type Note = Static<typeof Note>;

export const NoteId = Type.Object({ id: Type.String() });
export const NotePath = Type.Object({ id: Type.String(), side: Side });

export const Notes = Type.Object({ notes: Type.Array(Note) });
export type Notes = Static<typeof Notes>;

/** `POST /v1/calls/:id/notes`: the uploads are in (the listed sides), make the notes. The same `take` again returns the same note. */
export const NewNotes = Type.Object({
    title: Type.Optional(
        Type.String({
            description:
                'The title the client gave the note ("Call 24 Oct 2026, 11:05"): kept unless the call has no meeting and the summary has a title',
        }),
    ),
    take: Type.Integer({ minimum: 1, description: 'The recording’s start (ms): which recording of the call this is' }),
    endedAt: Type.Integer({ description: 'The recording’s end (ms)' }),
    sides: Type.Array(Side, {
        description:
            'The uploads that are complete. `me` and `others` together: the transcript is read again; none: only the live one is kept',
    }),
    speaker: Type.String(),
    meeting: Type.Optional(MeetingDetails),
    keepAudio: Type.Boolean({ description: 'Off: the audio is deleted from storage once the notes are ready' }),
    summarize: Type.Boolean(),
    language: Type.Optional(Type.String({ description: 'What the live recognition heard when it isn’t the project’s language' })),
    projectId: Type.Optional(Type.String({ description: 'The project the note belongs to; the call’s by default' })),
});
export type NewNotes = Static<typeof NewNotes>;

/** `GET /v1/notes?project=ID`. */
export const NotesQuery = Type.Object({ project: Type.Optional(Type.String()) });

/** `PATCH /v1/notes/:id`: one change. Rename a person throughout the note (whole words), apply a suggested name, or dismiss it. */
export const NotePatch = Type.Union([
    Type.Object({ rename: Type.Object({ from: Type.String(), to: Type.String() }) }),
    Type.Object({ apply: Type.String({ description: 'The label whose suggested name is used' }) }),
    Type.Object({ dismiss: Type.String({ description: 'The label whose suggested name is dropped' }) }),
]);
export type NotePatch = Static<typeof NotePatch>;

/** `POST /v1/notes/import`: a note the Mac had before it had an account (its Markdown, taken apart). The same `stamp` again is the same note. */
export const NoteImport = Type.Object({
    stamp: Type.String({ description: 'ISO 8601 start of the call, the note’s identity on the Mac' }),
    projectId: Type.String(),
    title: Type.String(),
    startedAt: Type.Integer(),
    durationSeconds: Type.Number(),
    language: Type.String(),
    speaker: Type.String(),
    meeting: Type.Optional(MeetingDetails),
    participants: Type.Array(Type.String()),
    summary: Type.String(),
    transcriptHeading: Type.String(),
    transcript: Type.Array(Turn),
    suggestions: Type.Record(Type.String(), Type.String()),
});
export type NoteImport = Static<typeof NoteImport>;

// MARK: Progress

/**
 * `GET /v1/notes/:id/events[?after=SEQ]` (server-sent events; `Last-Event-ID` works too): what the Workflow does, one event per line the session log
 * writes. `line` is that line exactly (`🔁 Improving transcript…`, `✅ Transcript improved: 5 segments (0.1 s for 0:27 of audio)`, `📝 Notes ready`
 * is the client’s: it names the file); the event name is `step` and `note`. `state` of a step event moves pending → running → done|failed.
 */
export const NoteEvent = Type.Object({
    seq: Type.Integer(),
    kind: Type.Union([Type.Literal('step'), Type.Literal('suggestion'), Type.Literal('note')]),
    step: Type.Union([NoteStepId, Type.Null()]),
    state: Type.Union([Type.Literal('running'), Type.Literal('done'), Type.Literal('failed'), Type.Literal('ready')]),
    line: Type.Union([Type.String(), Type.Null()], { description: 'The session log line this event stands for, if it stands for one' }),
    detail: Type.Union([Type.String(), Type.Null()]),
    at: Type.Integer(),
});
export type NoteEvent = Static<typeof NoteEvent>;
export const EventsQuery = Type.Object({ after: Type.Optional(Type.Integer({ minimum: 0 })) });
