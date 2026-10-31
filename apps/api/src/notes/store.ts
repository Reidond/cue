import type { Note, NoteEvent, NoteStep, Side } from '@cue/contract';
import type { Line, Voice } from './transcript.ts';

// Notes in D1 (migrations/0007_notes.sql): the row, the API's `Note` made of it, and the events the Workflow writes as it goes.

export interface NoteRow {
    id: string;
    user_id: string;
    call_id: string | null;
    project_id: string | null;
    take: number | null;
    stamp: string | null;
    title: string;
    started_at: number;
    ended_at: number | null;
    duration_seconds: number;
    status: 'processing' | 'ready';
    language: string;
    spoken_language: string | null;
    speaker: string;
    meeting: string | null;
    participants: string;
    summary: string;
    transcript_heading: string;
    transcript: string;
    lines: string;
    voices: string | null;
    suggestions: string;
    steps: string;
    audio: string;
    keep_audio: number;
    summarize: number;
    ready_at: number | null;
    audio_deleted_at: number | null;
    trashed_at: number | null;
    created_at: number;
}

export const NOTE_COLUMNS =
    'id, user_id, call_id, project_id, take, stamp, title, started_at, ended_at, duration_seconds, status, language, spoken_language, speaker, meeting, participants, summary, transcript_heading, transcript, lines, voices, suggestions, steps, audio, keep_audio, summarize, ready_at, audio_deleted_at, trashed_at, created_at';

export type StepId = NoteStep['id'];

export const STEP_TITLES: Record<StepId, string> = {
    transcript: 'Improving transcript',
    speakers: 'Finding speakers',
    names: 'Suggesting names',
    summary: 'Writing summary',
};

/** The R2 object keys of a note's audio, by side. */
export type AudioKeys = Partial<Record<Side, string>>;

export const parse = <T>(text: string | null, fallback: T): T => (text === null ? fallback : (JSON.parse(text) as T));

export function noteOf(row: NoteRow): Note {
    return {
        id: row.id,
        callId: row.call_id,
        projectId: row.project_id,
        title: row.title,
        startedAt: row.started_at,
        durationSeconds: row.duration_seconds,
        status: row.status,
        language: row.language,
        speaker: row.speaker,
        meeting: parse(row.meeting, null),
        participants: parse(row.participants, []),
        summary: row.summary,
        transcriptHeading: row.transcript_heading,
        transcript: parse(row.transcript, []),
        suggestions: parse(row.suggestions, {}),
        steps: parse(row.steps, []),
        audio: Object.keys(parse<AudioKeys>(row.audio, {})) as Side[],
        createdAt: row.created_at,
    };
}

export const linesOf = (row: NoteRow) => parse<Line[]>(row.lines, []);
export const voicesOf = (row: NoteRow) => parse<Voice[] | null>(row.voices, null);

export async function findNote(db: D1Database, userId: string, id: string): Promise<NoteRow | null> {
    return db
        .prepare(`SELECT ${NOTE_COLUMNS} FROM note WHERE id = ? AND user_id = ? AND trashed_at IS NULL`)
        .bind(id, userId)
        .first<NoteRow>();
}

export async function loadNote(db: D1Database, id: string): Promise<NoteRow> {
    const row = await db.prepare(`SELECT ${NOTE_COLUMNS} FROM note WHERE id = ?`).bind(id).first<NoteRow>();
    if (!row) throw new Error('The note is gone');
    return row;
}

/** The events a client follows: one per session-log line, plus the `note` event that ends the stream. */
export async function addEvent(
    db: D1Database,
    noteId: string,
    event: { kind: NoteEvent['kind']; step?: StepId | null; state: NoteEvent['state']; line?: string | null; detail?: string | null },
): Promise<void> {
    await db
        .prepare('INSERT INTO note_event (note_id, kind, step, state, line, detail, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(noteId, event.kind, event.step ?? null, event.state, event.line ?? null, event.detail ?? null, Date.now())
        .run();
}

export async function eventsAfter(db: D1Database, noteId: string, after: number): Promise<NoteEvent[]> {
    const { results } = await db
        .prepare('SELECT seq, kind, step, state, line, detail, at FROM note_event WHERE note_id = ? AND seq > ? ORDER BY seq')
        .bind(noteId, after)
        .all<NoteEvent>();
    return results;
}

/** Moves one step of the note's list on (and says so in an event when it has a `line`). */
export async function setStep(
    db: D1Database,
    noteId: string,
    id: StepId,
    state: NoteStep['state'],
    detail: string | null,
    line: string | null = null,
): Promise<void> {
    const row = await db.prepare('SELECT steps FROM note WHERE id = ?').bind(noteId).first<{ steps: string }>();
    const steps = parse<NoteStep[]>(row?.steps ?? null, []);
    const step = steps.find((candidate) => candidate.id === id);
    if (step) {
        step.state = state;
        step.detail = detail;
        await db.prepare('UPDATE note SET steps = ? WHERE id = ?').bind(JSON.stringify(steps), noteId).run();
    }
    await addEvent(db, noteId, { kind: 'step', step: id, state: state === 'pending' ? 'running' : state, line, detail });
}

export const newSteps = (ids: StepId[]): NoteStep[] => ids.map((id) => ({ id, title: STEP_TITLES[id], state: 'pending', detail: null }));
