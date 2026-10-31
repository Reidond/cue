// A client of the backend's live socket (`GET /v1/live`), for cases that talk to the backend without the Mac app: it connects with a bearer token,
// streams audio the way the app does (frames of one channel byte and 16-bit PCM), sends commands, and keeps every event it gets.
import { writeFile } from 'node:fs/promises';
import type { CallCommand, CallEvent } from '../../../packages/contract/src/calls.ts';
import type { Backend } from './backend.ts';
import { fail } from './results.ts';
import { sleep } from './time.ts';

const RATE = 16_000;

type Of<Type extends CallEvent['type']> = Extract<CallEvent, { type: Type }>;

export class LiveClient {
    readonly events: CallEvent[] = [];
    readonly #socket: WebSocket;
    #closed = false;
    #opened: Promise<void>;
    /** Why the socket ended, once it has. */
    closeReason: string | undefined;

    private constructor(socket: WebSocket) {
        this.#socket = socket;
        this.#opened = new Promise((resolve, reject) => {
            socket.addEventListener('open', () => resolve());
            socket.addEventListener('error', () => reject(new Error('the live socket could not be opened')));
        });
        socket.addEventListener('message', (message) => {
            if (typeof message.data === 'string') this.events.push(JSON.parse(message.data) as CallEvent);
        });
        socket.addEventListener('close', (event) => {
            this.#closed = true;
            this.closeReason = `${event.code} ${event.reason}`;
        });
    }

    /** Opens `/v1/live` for a call; `after` asks for the events the server still has after that sequence number. Rejects when the server refuses. */
    static async connect(backend: Backend, token: string, callId: string, after?: number): Promise<LiveClient> {
        const url = new URL('/v1/live', backend.url.replace(/^http/, 'ws'));
        url.searchParams.set('call', callId);
        if (after !== undefined) url.searchParams.set('after', String(after));
        // Node's WebSocket (undici) takes request headers as an option.
        const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } } as unknown as string[]);
        socket.binaryType = 'arraybuffer';
        const client = new LiveClient(socket);
        await client.#opened;
        return client;
    }

    /** The highest sequence number seen. */
    get lastSeq(): number {
        return this.events.reduce((highest, event) => Math.max(highest, event.seq), 0);
    }

    get closed(): boolean {
        return this.#closed;
    }

    command(command: CallCommand): void {
        this.#socket.send(JSON.stringify(command));
    }

    /** One audio frame: the channel's byte, then the PCM. */
    audio(channel: 'me' | 'others', pcm: Buffer): void {
        if (this.#socket.readyState !== WebSocket.OPEN) return;
        this.#socket.send(Buffer.concat([Buffer.from([channel === 'me' ? 0 : 1]), pcm]));
    }

    /** Plays 16-bit mono 16 kHz PCM as a channel, in real time (100 ms at a time) unless `fast`. */
    async play(channel: 'me' | 'others', pcm: Buffer, options: { fast?: boolean; chunkMs?: number } = {}): Promise<void> {
        const chunk = Math.round(((options.chunkMs ?? 100) / 1000) * RATE) * 2;
        const start = performance.now();
        for (let offset = 0; offset < pcm.length; offset += chunk) {
            this.audio(channel, pcm.subarray(offset, offset + chunk));
            if (!options.fast) await sleep(Math.max(0, (offset + chunk) / 2 / RATE - (performance.now() - start) / 1000));
        }
    }

    /** Ends the connection without a goodbye, as a lost network would. */
    drop(): void {
        this.#socket.close(4000, 'dropped');
    }

    /** The events of a type, in order. */
    of<Type extends CallEvent['type']>(type: Type): Of<Type>[] {
        return this.events.filter((event): event is Of<Type> => event.type === type);
    }

    /** Waits for an event of `type` (that `check` accepts, if given) that has not been waited for before; fails the case on timeout. */
    async next<Type extends CallEvent['type']>(type: Type, check: (event: Of<Type>) => boolean = () => true, seconds = 30, from = 0): Promise<Of<Type>> {
        const deadline = Date.now() + seconds * 1000;
        for (;;) {
            const found = this.of(type).find((event) => event.seq > from && check(event));
            if (found) return found;
            if (Date.now() > deadline) {
                return fail(`timed out after ${seconds}s waiting for a ${type} event`, ...this.events.filter((event) => event.type !== 'transcript.partial').slice(-60).map((event) => JSON.stringify(event)));
            }
            await sleep(0.1);
        }
    }

    /** The text of an answer so far (its deltas, joined). */
    answerTo(questionId: string): string {
        return this.of('answer.delta')
            .filter((event) => event.questionId === questionId)
            .map((event) => event.text)
            .join('');
    }

    close(): void {
        if (!this.#closed) this.#socket.close(1000, 'done');
    }
}

/**
 * Writes `out` (a 16 kHz mono 16-bit WAV, `seconds` long) with loud, speech-like sound in the `bursts` (start and end, in seconds) and digital silence
 * elsewhere: what the Deepgram stand-in tells speech from silence by. No voices needed, so it works on any machine.
 */
export async function bursts(out: string, seconds: number, spans: [number, number][]): Promise<string> {
    const samples = Math.round(seconds * RATE);
    const data = Buffer.alloc(samples * 2);
    for (const [from, to] of spans) {
        for (let index = Math.round(from * RATE); index < Math.min(samples, Math.round(to * RATE)); index++) {
            const t = index / RATE;
            // A voice-ish mix of tones that wavers like syllables, at a level far above the silence threshold.
            const value = 0.25 * Math.sin(2 * Math.PI * 180 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 4 * t)) + 0.1 * Math.sin(2 * Math.PI * 1300 * t);
            data.writeInt16LE(Math.round(value * 32767), index * 2);
        }
    }
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data.length, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(RATE, 24);
    header.writeUInt32LE(RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data.length, 40);
    await writeFile(out, Buffer.concat([header, data]));
    return out;
}

/** The PCM of a WAV made by `bursts` (or any 16 kHz mono 16-bit one): everything after the `data` chunk's header. */
export function pcmOf(wav: Buffer): Buffer {
    let offset = 12;
    while (offset + 8 <= wav.length && wav.toString('ascii', offset, offset + 4) !== 'data') offset += 8 + wav.readUInt32LE(offset + 4);
    return wav.subarray(offset + 8);
}

export interface StartedCall {
    token: string;
    projectId: string;
    callId: string;
    startedAt: number;
}

/**
 * Signs `email` in, makes a project with the given files (paths) as its materials, and starts a call for it (`POST /v1/calls`): what the app does
 * when it starts listening.
 */
export async function startCall(
    backend: Backend,
    email: string,
    options: { language?: string; namesAndTerms?: string; materials?: string[]; call?: Record<string, unknown> } = {},
): Promise<StartedCall> {
    await backend.invite(email);
    const token = (await backend.tokensFor(email)).access_token;
    const created = await backend.call('POST', '/v1/projects', token, {
        body: { name: 'Bee talk', language: options.language ?? 'en', occasion: 'A talk about rooftop bees', namesAndTerms: options.namesAndTerms ?? '' },
    });
    if (created.status !== 201) return fail('creating the project failed', JSON.stringify(created));
    const projectId = (created.body as { id: string }).id;
    for (const path of options.materials ?? []) {
        const uploaded = await backend.call('POST', `/v1/projects/${projectId}/materials`, token, { file: { path } });
        if (uploaded.status !== 201) return fail(`uploading ${path} failed`, JSON.stringify(uploaded));
    }
    const started = await backend.call('POST', '/v1/calls', token, { body: { projectId, speaker: 'Andrii', ...options.call } });
    if (started.status !== 201) return fail('starting the call failed', JSON.stringify(started));
    const call = started.body as { callId: string; startedAt: number };
    return { token, projectId, callId: call.callId, startedAt: call.startedAt };
}
