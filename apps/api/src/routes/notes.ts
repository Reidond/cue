import {
    ApiError as ApiErrorBody,
    CallId,
    Deleted,
    EventsQuery,
    NewNotes,
    Note,
    NoteId,
    NoteImport,
    NotePatch,
    NotePath,
    Notes,
    NotesQuery,
    type Side,
} from '@cue/contract';
import { env } from 'cloudflare:workers';
import { Elysia, sse } from 'elysia';
import { callOf } from '../call/stub.ts';
import { ApiError } from '../errors.ts';
import { findProject } from '../projects.ts';
import { janitor } from '../notes/janitor.ts';
import { participantsOf, turnsFor } from '../notes/compose.ts';
import { noteLexicon } from '../notes/lexicon.ts';
import {
    addEvent,
    type AudioKeys,
    eventsAfter,
    findNote,
    NOTE_COLUMNS,
    type NoteRow,
    newSteps,
    noteOf,
    parse,
    type StepId,
} from '../notes/store.ts';
import { type Line, replacingName } from '../notes/transcript.ts';
import { authed } from './authed.ts';
import { contentTypeOf } from './recordings.ts';

const errors = { 400: ApiErrorBody, 401: ApiErrorBody, 404: ApiErrorBody };

const mustFind = async (userId: string, id: string): Promise<NoteRow> => {
    const row = await findNote(env.DB, userId, id);
    if (!row) throw new ApiError('not_found', 'That note does not exist.');
    return row;
};

interface CallRow {
    id: string;
    project_id: string | null;
    started_at: number;
    ended_at: number | null;
    transcript: string;
}

/** The final lines of a call, whether it is over (kept in D1) or still going (the Call Durable Object has them). */
async function liveLines(call: CallRow): Promise<Line[]> {
    if (call.ended_at !== null) return parse<Line[]>(call.transcript, []);
    return callOf(call.id).lines();
}

/** Whole recordings only: the lines inside [take, endedAt], their times counted from the recording's start instead of the call's. */
function inRecording(lines: Line[], call: CallRow, take: number, endedAt: number): Line[] {
    const offset = (take - call.started_at) / 1000;
    const duration = Math.max(0, (endedAt - take) / 1000);
    return lines
        .map((line) => ({ ...line, start: line.start - offset, end: line.end - offset }))
        .filter((line) => line.start < duration && line.end > 0)
        .map((line) => ({ ...line, start: Math.max(0, line.start), end: Math.max(0, line.end) }))
        .toSorted((a, b) => a.start - b.start);
}

const insertNote = (row: Omit<NoteRow, 'ready_at' | 'audio_deleted_at' | 'trashed_at'> & Partial<NoteRow>) =>
    env.DB.prepare(
        `INSERT INTO note (${NOTE_COLUMNS}) VALUES (${NOTE_COLUMNS.split(',')
            .map(() => '?')
            .join(', ')})`,
    ).bind(
        row.id,
        row.user_id,
        row.call_id,
        row.project_id,
        row.take,
        row.stamp,
        row.title,
        row.started_at,
        row.ended_at,
        row.duration_seconds,
        row.status,
        row.language,
        row.spoken_language,
        row.speaker,
        row.meeting,
        row.participants,
        row.summary,
        row.transcript_heading,
        row.transcript,
        row.lines,
        row.voices,
        row.suggestions,
        row.steps,
        row.audio,
        row.keep_audio,
        row.summarize,
        row.ready_at ?? null,
        row.audio_deleted_at ?? null,
        row.trashed_at ?? null,
        row.created_at,
    );

/** Deletes a note's audio from R2 and from the note. */
async function dropAudio(id: string, keys: AudioKeys): Promise<void> {
    await Promise.all(Object.values(keys).map((key) => env.RECORDINGS.delete(key)));
    await env.DB.prepare("UPDATE note SET audio = '{}', audio_deleted_at = ? WHERE id = ?").bind(Date.now(), id).run();
}

/**
 * A rename, throughout the note: its transcript, summary, title and participants, whole words only (the other people keep their labels). Two
 * labels that turn out to be one person become one participant, and the name suggested for the old one is dropped.
 */
function renamed(row: NoteRow, from: string, name: string): Record<string, string> {
    const turns = parse<{ label: string; text: string }[]>(row.transcript, []).map((turn) => ({
        ...turn,
        label: replacingName(from, name, turn.label),
        text: replacingName(from, name, turn.text),
    }));
    const people: string[] = [];
    for (const person of parse<string[]>(row.participants, []).map((candidate) => (candidate === from ? name : candidate))) {
        if (!people.includes(person)) people.push(person);
    }
    const suggestions = parse<Record<string, string>>(row.suggestions, {});
    delete suggestions[from];
    return {
        title: replacingName(from, name, row.title),
        summary: replacingName(from, name, row.summary),
        transcript: JSON.stringify(turns),
        participants: JSON.stringify(people),
        suggestions: JSON.stringify(suggestions),
    };
}

/** Notes: made from a recording by the Workflow (src/notes/workflow.ts), listed, followed while they are made, edited, trashed, and played from. */
export const notes = new Elysia({ name: 'notes' })
    .use(authed)
    .post(
        '/calls/:id/notes',
        async ({ userId, params, body, status }) => {
            const call = await env.DB.prepare(
                'SELECT id, project_id, started_at, ended_at, transcript FROM call WHERE id = ? AND user_id = ?',
            )
                .bind(params.id, userId)
                .first<CallRow>();
            if (!call) throw new ApiError('not_found', 'That call does not exist.');

            // The same recording again is the same note.
            const existing = await env.DB.prepare(`SELECT ${NOTE_COLUMNS} FROM note WHERE call_id = ? AND take = ? AND user_id = ?`)
                .bind(call.id, body.take, userId)
                .first<NoteRow>();
            if (existing) return status(200, noteOf(existing));

            const project = await findProject(env.DB, userId, body.projectId ?? call.project_id ?? '');
            if (!project) throw new ApiError('not_found', 'That project does not exist.');

            // The audio that is in: each listed side must be a finished upload.
            const { results: uploads } = await env.DB.prepare(
                "SELECT side, object_key FROM upload WHERE user_id = ? AND call_id = ? AND take = ? AND status = 'done'",
            )
                .bind(userId, call.id, body.take)
                .all<{ side: Side; object_key: string }>();
            const audio: AudioKeys = {};
            for (const side of new Set(body.sides)) {
                const upload = uploads.find((candidate) => candidate.side === side);
                if (!upload) throw new ApiError('bad_request', `The recording of ${side} is not completely uploaded.`);
                audio[side] = upload.object_key;
            }

            const lexicon = noteLexicon(project.language);
            const lines = inRecording(await liveLines(call), call, body.take, body.endedAt);
            const speaker = body.speaker.trim();
            const reads = audio.me !== undefined && audio.others !== undefined;
            const steps: StepId[] = [
                ...(reads ? (['transcript', 'speakers'] as const) : []),
                ...(body.summarize ? (['names', 'summary'] as const) : []),
            ];
            const id = crypto.randomUUID();
            const title = body.meeting?.title ?? body.title ?? 'Call';
            await insertNote({
                id,
                user_id: userId,
                call_id: call.id,
                project_id: project.id,
                take: body.take,
                stamp: null,
                title,
                started_at: body.take,
                ended_at: body.endedAt,
                duration_seconds: Math.max(0, (body.endedAt - body.take) / 1000),
                status: 'processing',
                language: project.language,
                spoken_language: body.language && body.language !== project.language ? body.language : null,
                speaker,
                meeting: body.meeting ? JSON.stringify(body.meeting) : null,
                participants: JSON.stringify(participantsOf(lexicon, speaker, lines)),
                summary: '',
                transcript_heading: lexicon.transcriptHeading,
                transcript: JSON.stringify(turnsFor(lexicon, speaker, lines)),
                lines: JSON.stringify(lines),
                voices: null,
                suggestions: '{}',
                steps: JSON.stringify(newSteps(steps)),
                audio: JSON.stringify(audio),
                keep_audio: body.keepAudio ? 1 : 0,
                summarize: body.summarize ? 1 : 0,
                created_at: Date.now(),
            }).run();
            await env.NOTES.create({ id, params: { noteId: id } });
            return status(202, noteOf((await findNote(env.DB, userId, id))!));
        },
        {
            params: CallId,
            body: NewNotes,
            response: { 200: Note, 202: Note, ...errors },
            detail: {
                summary: 'Starts the notes Workflow for a recording whose audio is uploaded; the same recording again is the same note',
            },
        },
    )
    .get(
        '/notes',
        async ({ userId, query }) => {
            const { results } = await env.DB.prepare(
                `SELECT ${NOTE_COLUMNS} FROM note WHERE user_id = ?1 AND trashed_at IS NULL AND (?2 IS NULL OR project_id = ?2) ORDER BY started_at DESC`,
            )
                .bind(userId, query.project ?? null)
                .all<NoteRow>();
            return { notes: results.map(noteOf) };
        },
        {
            query: NotesQuery,
            response: { 200: Notes, 401: ApiErrorBody },
            detail: { summary: 'Notes, newest first (not the ones in the trash)' },
        },
    )
    .get('/notes/:id', async ({ userId, params }) => noteOf(await mustFind(userId, params.id)), {
        params: NoteId,
        response: { 200: Note, ...errors },
        detail: { summary: 'One note, with the steps of its Workflow' },
    })
    .get(
        '/notes/:id/events',
        async function* ({ userId, params, query, request }) {
            const row = await mustFind(userId, params.id);
            let after = Number(query.after ?? request.headers.get('last-event-id') ?? 0);
            if (!Number.isFinite(after)) after = 0;
            let quiet = 0;
            for (;;) {
                for (const event of await eventsAfter(env.DB, params.id, after)) {
                    after = event.seq;
                    quiet = 0;
                    yield sse({ id: event.seq, event: event.kind, data: event });
                    if (event.kind === 'note') return;
                }
                // A note that was ready before the client came has no more to say.
                if (quiet === 0 && row.status === 'ready' && (await eventsAfter(env.DB, params.id, after)).length === 0) {
                    const current = await env.DB.prepare('SELECT status FROM note WHERE id = ?')
                        .bind(params.id)
                        .first<{ status: string }>();
                    if (current?.status === 'ready') return;
                }
                quiet++;
                // A Workflow that died without saying so leaves the note as it is, ready, and the stream ends with the failure.
                if (quiet % 20 === 0) {
                    const status = (
                        await env.NOTES.get(params.id)
                            .then((instance) => instance.status())
                            .catch(() => null)
                    )?.status;
                    if (status === 'errored' || status === 'terminated') {
                        await env.DB.prepare("UPDATE note SET status = 'ready', ready_at = COALESCE(ready_at, ?) WHERE id = ?")
                            .bind(Date.now(), params.id)
                            .run();
                        await addEvent(env.DB, params.id, { kind: 'note', state: 'failed', detail: 'The notes could not be finished.' });
                        await janitor().ensure();
                    }
                }
                // A beat now and then keeps the connection open while a long step runs.
                if (quiet % 80 === 0) yield sse({ event: 'ping', data: {} });
                if (quiet > 4800) return;
                await new Promise((resolve) => setTimeout(resolve, quiet < 80 ? 250 : 1000));
            }
        },
        {
            // An error thrown inside a streaming handler reaches no error hook: another person's note is refused before the stream starts.
            beforeHandle: async ({ userId, params }) => {
                await mustFind(userId, params.id);
            },
            params: NoteId,
            query: EventsQuery,
            detail: {
                summary:
                    'Server-sent events: what the notes Workflow does (`step`, `suggestion`, then `note`), after `?after=` or Last-Event-ID',
            },
        },
    )
    .patch(
        '/notes/:id',
        async ({ userId, params, body }) => {
            const row = await mustFind(userId, params.id);
            if (row.status !== 'ready') throw new ApiError('bad_request', 'The note is still being made.', true);
            const suggestions = parse<Record<string, string>>(row.suggestions, {});
            let change: Record<string, string> = {};
            if ('rename' in body || 'apply' in body) {
                const from = 'rename' in body ? body.rename.from : body.apply;
                const wanted = 'rename' in body ? body.rename.to : suggestions[body.apply];
                if (wanted === undefined) throw new ApiError('not_found', 'That name was not suggested.');
                // Commas would split the participants, asterisks the transcript's speaker lines.
                const name = wanted.replace(/[,*\n]/g, '').trim();
                if (name === '' || name === from) return noteOf(row);
                change = renamed(row, from, name);
            } else {
                delete suggestions[body.dismiss];
                change = { suggestions: JSON.stringify(suggestions) };
            }
            const columns = Object.keys(change);
            await env.DB.prepare(`UPDATE note SET ${columns.map((column) => `${column} = ?`).join(', ')} WHERE id = ?`)
                .bind(...columns.map((column) => change[column]), params.id)
                .run();
            return noteOf((await findNote(env.DB, userId, params.id))!);
        },
        {
            params: NoteId,
            body: NotePatch,
            response: { 200: Note, ...errors },
            detail: { summary: 'Renames a person throughout the note, applies a suggested name, or dismisses it' },
        },
    )
    .delete(
        '/notes/:id',
        async ({ userId, params }) => {
            const row = await mustFind(userId, params.id);
            await env.DB.prepare('UPDATE note SET trashed_at = ? WHERE id = ?').bind(Date.now(), params.id).run();
            // A note being made stops being made.
            if (row.status === 'processing')
                await env.NOTES.get(params.id)
                    .then((instance) => instance.terminate())
                    .catch(() => {});
            await dropAudio(params.id, parse<AudioKeys>(row.audio, {}));
            return { deleted: params.id };
        },
        {
            params: NoteId,
            response: { 200: Deleted, ...errors },
            detail: { summary: 'Moves a note to the trash: it is gone from lists and its audio is deleted' },
        },
    )
    .get(
        '/notes/:id/audio/:side',
        async ({ userId, params, request }) => {
            const row = await mustFind(userId, params.id);
            const key = parse<AudioKeys>(row.audio, {})[params.side];
            const object = key ? await env.RECORDINGS.get(key, { range: request.headers }) : null;
            if (!object) throw new ApiError('not_found', 'That audio is not in storage (it may be past its retention).');
            const headers = new Headers({ 'content-type': contentTypeOf(params.side), 'accept-ranges': 'bytes', etag: object.httpEtag });
            // R2 describes the whole object as a range too: only a request that asked for one gets a 206.
            const range = request.headers.has('range') ? object.range : undefined;
            if (range) {
                const offset =
                    'offset' in range && range.offset !== undefined
                        ? range.offset
                        : object.size - ('suffix' in range && range.suffix ? range.suffix : object.size);
                const length = 'length' in range && range.length !== undefined ? range.length : object.size - offset;
                headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
                headers.set('content-length', String(length));
                return new Response(object.body, { status: 206, headers });
            }
            headers.set('content-length', String(object.size));
            return new Response(object.body, { headers });
        },
        { params: NotePath, detail: { summary: 'A note’s audio from storage, with range requests (to play from a timestamp)' } },
    )
    .put(
        '/notes/:id/audio/:side',
        async ({ userId, params, request }) => {
            const row = await mustFind(userId, params.id);
            if (params.side !== 'mixed') throw new ApiError('bad_request', 'Only the mixed audio can be added to a note.');
            const size = Number(request.headers.get('content-length'));
            if (!Number.isInteger(size) || size <= 0 || !request.body)
                throw new ApiError('bad_request', 'Send the audio as the request body, with its Content-Length.');
            const key = `users/${userId}/notes/${params.id}/mixed.m4a`;
            await env.RECORDINGS.put(key, request.body, { httpMetadata: { contentType: contentTypeOf('mixed') } });
            const keys = { ...parse<AudioKeys>(row.audio, {}), mixed: key };
            await env.DB.prepare('UPDATE note SET audio = ?, audio_deleted_at = NULL WHERE id = ?')
                .bind(JSON.stringify(keys), params.id)
                .run();
            await janitor().ensure();
            return noteOf((await findNote(env.DB, userId, params.id))!);
        },
        {
            // The route reads its own body: Elysia would buffer it and the stream could not go to R2.
            parse: () => true,
            params: NotePath,
            response: { 200: Note, ...errors },
            detail: { summary: 'Adds the mixed audio to a note imported from a Mac’s library' },
        },
    )
    .post(
        '/notes/import',
        async ({ userId, body, status }) => {
            const project = await findProject(env.DB, userId, body.projectId);
            if (!project) throw new ApiError('not_found', 'That project does not exist.');
            const existing = await env.DB.prepare(`SELECT ${NOTE_COLUMNS} FROM note WHERE user_id = ? AND stamp = ?`)
                .bind(userId, body.stamp)
                .first<NoteRow>();
            if (existing) return status(200, noteOf(existing));
            const id = crypto.randomUUID();
            const now = Date.now();
            await insertNote({
                id,
                user_id: userId,
                call_id: null,
                project_id: project.id,
                take: null,
                stamp: body.stamp,
                title: body.title,
                started_at: body.startedAt,
                ended_at: Math.round(body.startedAt + body.durationSeconds * 1000),
                duration_seconds: body.durationSeconds,
                status: 'ready',
                language: body.language,
                spoken_language: null,
                speaker: body.speaker,
                meeting: body.meeting ? JSON.stringify(body.meeting) : null,
                participants: JSON.stringify(body.participants),
                summary: body.summary,
                transcript_heading: body.transcriptHeading,
                transcript: JSON.stringify(body.transcript),
                lines: '[]',
                voices: null,
                suggestions: JSON.stringify(body.suggestions),
                steps: '[]',
                audio: '{}',
                keep_audio: 1,
                summarize: 1,
                ready_at: now,
                created_at: now,
            }).run();
            return status(201, noteOf((await findNote(env.DB, userId, id))!));
        },
        {
            body: NoteImport,
            response: { 200: Note, 201: Note, ...errors },
            detail: { summary: 'Adds a note the Mac had before it had an account; the same stamp again is the same note' },
        },
    );
