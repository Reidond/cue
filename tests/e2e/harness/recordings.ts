// A client of the backend's recording upload and notes (`/v1/calls/:id/recording/:side`, `/v1/calls/:id/notes`, `/v1/notes`), for cases that talk to the
// backend without the Mac app: it uploads a recording in parts the way the app does (and can lose the connection partway), starts the notes, follows their
// events and reads them back. The shapes are packages/contract/src/notes.ts.
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { NewNotes, Note, NoteEvent, Upload } from '../../../packages/contract/src/notes.ts';
import type { Backend } from './backend.ts';
import type { Cue } from './sandbox.ts';
import { bursts, LiveClient, pcmOf, startCall, type StartedCall } from './live.ts';
import { fail } from './results.ts';

export const MIB = 1024 * 1024;

export type Side = 'me' | 'others' | 'mixed';

export interface UploadOptions {
    /** The recording's start (ms): which recording of the call this is. */
    take: number;
    /** The size of a part; R2 wants every part but the last to be at least 5 MiB (the default). */
    partBytes?: number;
    /** The upload's content type (default audio/wav). */
    contentType?: string;
    /**
     * Loses the connection while this part (1-based) is being sent, after `bytes` of it: the request is torn down, as a lost network would, and
     * the client does what the app does: asks where the upload stands and sends the parts that are missing.
     */
    breakAt?: { part: number; bytes: number };
}

export interface Uploaded {
    uploadId: string;
    /** Every part sent, in order, including the ones that broke (`false`). */
    attempts: { part: number; ok: boolean }[];
    /** The parts the server already had when the client asked after the break, by number. */
    resumed: number[];
    size: number | null;
}

/** `PUT` of one part as raw bytes; with `cutAfter` the connection is destroyed after that many bytes (the request rejects). */
async function putPart(
    backend: Backend,
    token: string,
    path: string,
    bytes: Buffer,
    contentType: string,
    cutAfter?: number,
): Promise<{ status: number; body: any }> {
    const url = new URL(path, backend.url);
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            url,
            {
                method: 'PUT',
                headers: { authorization: `Bearer ${token}`, 'content-type': contentType, 'content-length': String(bytes.length) },
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on('data', (chunk: Buffer) => chunks.push(chunk));
                response.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    try {
                        resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) });
                    } catch {
                        resolve({ status: response.statusCode ?? 0, body: text });
                    }
                });
            },
        );
        req.on('error', reject);
        if (cutAfter === undefined) {
            req.end(bytes);
            return;
        }
        req.write(bytes.subarray(0, cutAfter), () => setTimeout(() => req.destroy(new Error('connection lost')), 150));
    });
}

/** The path of a side's upload: `/v1/calls/ID/recording/SIDE?take=…`, for a part `&part=N`, or its completion. */
const uploadPath = (callId: string, side: Side, take: number, how: { part?: number; complete?: boolean } = {}) =>
    `/v1/calls/${callId}/recording/${side}${how.complete ? '/complete' : ''}?take=${take}${how.part === undefined ? '' : `&part=${how.part}`}`;

/** Where an upload stands (`POST` on the side's path begins it, or, the same call again, says what arrived). */
export async function beginUpload(backend: Backend, token: string, callId: string, side: Side, take: number): Promise<Upload> {
    const begun = await backend.call('POST', uploadPath(callId, side, take), token);
    if (begun.status !== 200 && begun.status !== 201) return fail(`beginning the ${side} upload failed`, JSON.stringify(begun));
    return begun.body as Upload;
}

/**
 * Uploads a side's recording the way the app does: begin (or resume), send the parts the server lacks, complete. With `breakAt` one part's request is cut
 * partway, and the client then asks where the upload stands and sends what is missing. Returns what was sent.
 */
export async function uploadRecording(
    backend: Backend,
    token: string,
    callId: string,
    side: Side,
    bytes: Buffer,
    options: UploadOptions,
): Promise<Uploaded> {
    const { take, partBytes = 5 * MIB, contentType = 'audio/wav' } = options;
    const count = Math.max(1, Math.ceil(bytes.length / partBytes));
    const numbers = Array.from({ length: count }, (_, index) => index + 1);
    const attempts: Uploaded['attempts'] = [];
    const resumed: number[] = [];
    let upload = await beginUpload(backend, token, callId, side, take);
    const missing = () => numbers.filter((number) => !upload.parts.some((part) => part.partNumber === number));
    let broken = options.breakAt;
    for (let round = 0; missing().length > 0; round++) {
        if (round > 3) return fail(`the ${side} upload would not finish`, JSON.stringify({ attempts, missing: missing() }));
        let lost = false;
        for (const number of missing()) {
            const part = bytes.subarray((number - 1) * partBytes, number * partBytes);
            const path = uploadPath(callId, side, take, { part: number });
            if (broken?.part === number) {
                const cut = broken.bytes;
                broken = undefined;
                attempts.push({ part: number, ok: false });
                const outcome = await putPart(backend, token, path, part, contentType, cut).then(
                    () => 'sent',
                    () => 'lost',
                );
                if (outcome === 'sent') return fail('the cut request should not have gone through');
                lost = true;
                break;
            }
            const sent = await putPart(backend, token, path, part, contentType);
            attempts.push({ part: number, ok: sent.status === 200 });
            if (sent.status !== 200) return fail(`sending part ${number} of the ${side} recording failed`, JSON.stringify(sent));
            upload.parts.push({ partNumber: number, size: part.length });
        }
        if (lost) {
            upload = await beginUpload(backend, token, callId, side, take);
            resumed.push(...upload.parts.map((part) => part.partNumber));
        }
    }
    const done = await backend.call('POST', uploadPath(callId, side, take, { complete: true }), token);
    if (done.status !== 200) return fail(`completing the ${side} upload failed`, JSON.stringify(done));
    return { uploadId: upload.uploadId, attempts, resumed, size: (done.body as Upload).size };
}

/** `POST /v1/calls/:id/notes`: the status and the note. */
export async function startNotes(
    backend: Backend,
    token: string,
    callId: string,
    notes: Partial<NewNotes> & Pick<NewNotes, 'take' | 'endedAt'>,
): Promise<{ status: number; body: Note }> {
    return backend.call('POST', `/v1/calls/${callId}/notes`, token, {
        body: { sides: ['me', 'others'], speaker: 'Andrii', keepAudio: true, summarize: true, ...notes },
    });
}

/** The note as the API has it. */
export async function getNote(backend: Backend, token: string, id: string): Promise<Note> {
    const read = await backend.call('GET', `/v1/notes/${id}`, token);
    if (read.status !== 200) return fail(`reading the note failed`, JSON.stringify(read));
    return read.body as Note;
}

/** Waits until the Workflow is over (the note is `ready`, whatever its steps did), then returns the note. */
export async function waitForNote(cue: Cue, backend: Backend, token: string, id: string, seconds = 120): Promise<Note> {
    let note: Note | undefined;
    await cue.waitFor('the notes to be ready', seconds, async () => {
        note = await getNote(backend, token, id);
        return note.status === 'ready';
    });
    return note!;
}

/**
 * The events of a note's progress stream (`GET /v1/notes/:id/events`), read until the server closes it (after the note is ready) or `seconds` pass. `after` asks
 * for what came after that sequence number; `lastEventId` does the same with the SSE header a reconnecting browser sends.
 */
export async function noteEvents(
    backend: Backend,
    token: string,
    id: string,
    options: { after?: number; lastEventId?: number; seconds?: number } = {},
): Promise<NoteEvent[]> {
    const url = new URL(`/v1/notes/${id}/events`, backend.url);
    if (options.after !== undefined) url.searchParams.set('after', String(options.after));
    const response = await fetch(url, {
        headers: {
            authorization: `Bearer ${token}`,
            accept: 'text/event-stream',
            ...(options.lastEventId === undefined ? {} : { 'last-event-id': String(options.lastEventId) }),
        },
        signal: AbortSignal.timeout((options.seconds ?? 120) * 1000),
    });
    if (response.status !== 200) return fail(`the events stream answered ${response.status}`, await response.text());
    const events: NoteEvent[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const fields = block.split('\n');
            // A beat (`event: ping`) only keeps the connection open.
            if (fields.some((line) => /^event:\s*ping$/.test(line))) continue;
            const data = fields
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
            if (data !== '') events.push(JSON.parse(data) as NoteEvent);
        }
    }
    return events;
}

/** A recording made for the backend without the app: a call, the audio of both sides, and (with `live`) the live transcript the Deepgram stand-in gave it. */
export interface RecordedCall extends StartedCall {
    /** The recording's start (ms), `take` of its uploads and notes. */
    take: number;
    endedAt: number;
    me: Buffer;
    others: Buffer;
}

/**
 * Signs `email` in, starts a call and makes the audio of both sides (`bursts`: loud where each side speaks, silence elsewhere; the stand-in hears one
 * utterance per burst). With `live` the call is also streamed through the live socket in real time, as the app does, so the call has its live transcript,
 * and then ended. Without it the call is ended at once and the notes start from the recording alone.
 */
export async function recordCall(
    cue: Cue,
    backend: Backend,
    email: string,
    options: {
        seconds?: number;
        me?: [number, number][];
        others?: [number, number][];
        live?: boolean;
        language?: string;
        namesAndTerms?: string;
    } = {},
): Promise<RecordedCall> {
    const seconds = options.seconds ?? 12;
    const call = await startCall(backend, email, { language: options.language, namesAndTerms: options.namesAndTerms });
    const meWav = readFileSync(await bursts(cue.path('me.wav'), seconds, options.me ?? [[5, 6.5]]));
    const othersWav = readFileSync(
        await bursts(
            cue.path('others.wav'),
            seconds,
            options.others ?? [
                [1, 3.5],
                [8, 10],
            ],
        ),
    );
    if (options.live) {
        const live = await LiveClient.connect(backend, call.token, call.callId);
        await live.next('status', (status) => status.part === 'speech' && status.state === 'ready', 30);
        await Promise.all([live.play('others', pcmOf(othersWav)), live.play('me', pcmOf(meWav))]);
        await live.next('transcript.final', (line) => line.channel === 'me', 30);
        const ended = await backend.call('POST', `/v1/calls/${call.callId}/end`, call.token);
        if (ended.status !== 200) fail('ending the call failed', JSON.stringify(ended));
        await live.next('ended', () => true, 10);
        live.close();
    } else {
        const ended = await backend.call('POST', `/v1/calls/${call.callId}/end`, call.token);
        if (ended.status !== 200) fail('ending the call failed', JSON.stringify(ended));
    }
    return { ...call, take: call.startedAt, endedAt: call.startedAt + seconds * 1000, me: meWav, others: othersWav };
}

/** Uploads both sides of a recorded call (two complete uploads) and starts its notes; returns the note as it starts. */
export async function makeNotes(
    backend: Backend,
    recorded: RecordedCall,
    notes: Partial<NewNotes> = {},
    upload: Partial<UploadOptions> = {},
): Promise<Note> {
    const { token, callId, take } = recorded;
    await uploadRecording(backend, token, callId, 'me', recorded.me, { take, ...upload });
    await uploadRecording(backend, token, callId, 'others', recorded.others, { take, ...upload });
    const started = await startNotes(backend, token, callId, { take, endedAt: recorded.endedAt, ...notes });
    if (started.status !== 202 && started.status !== 200) return fail('starting the notes failed', JSON.stringify(started));
    return started.body;
}

/**
 * What the Deepgram stand-in's recorded-file API says (FAKE_DEEPGRAM_FILE) for a call made by `recordCall` with its default bursts: one line on
 * your side, two voices on the call side (it speaks first, so it is Participant 1).
 */
export const RECORDED_SCRIPT = JSON.stringify({
    me: ['I will send the report by Friday.'],
    others: [
        { text: 'Good morning. When is the report due?', speaker: 0 },
        { text: 'Thank you, Olena. See you on Monday.', speaker: 1 },
    ],
});

/** What the live stand-in (FAKE_DEEPGRAM_LIVE) hears of the same call, in the order the utterances start: the live transcript a note starts from. */
export const LIVE_SCRIPT = JSON.stringify([
    { text: 'Good morning, when is the report?', speaker: 0 },
    'I will send it by Friday.',
    { text: 'Thank you, Olena. See you Monday.', speaker: 1 },
]);
