import { env } from 'cloudflare:workers';
import { AUDIO, type Channel } from '@cue/contract';
import { SPEECH_MODEL } from './models.ts';

// One live Deepgram stream (Nova-3) for one channel of a call, over a WebSocket the Call Durable Object opens with the owner's key. The client's
// audio goes in as it comes; Deepgram's endpointing cuts it into utterances, which come out as partials and finals. A stream that drops is
// opened again at once (its audio meanwhile is lost) and the call is told speech recognition came back.

/** Keyterm prompting takes up to 500 tokens of terms; Deepgram suggests the 20–50 that matter most. */
const MAX_TERMS = 50;
/** Deepgram closes a stream that gets no audio for 10 s; a KeepAlive says it is wanted. */
const KEEP_ALIVE_MS = 5000;
/** How long a silence ends an utterance, and how long to wait for the words after a stop before calling it over. */
const ENDPOINTING_MS = 700;
const UTTERANCE_END_MS = 1500;
const RECONNECT_MS = [500, 1000, 2000, 5000];

export interface SpeechEvents {
    /** Someone started (true) or stopped (false) talking. */
    onSpeaking(active: boolean): void;
    /** The words so far of the utterance being said. Times are seconds since the call began. */
    onPartial(text: string, speaker: number | null, start: number, end: number): void;
    /** A finished utterance; empty text when nothing could be made of the sound (so that the call knows they stopped). */
    onFinal(text: string, speaker: number | null, start: number, end: number): void;
    /** The stream works (true), or does not, with a reason for people. */
    onState(ok: boolean, detail: string): void;
}

export interface SpeechParams {
    language: string;
    terms: string[];
    /** Tell the voices apart (the call's side). */
    diarize: boolean;
}

interface Word {
    speaker?: number;
}

interface Results {
    type: string;
    is_final?: boolean;
    speech_final?: boolean;
    start?: number;
    duration?: number;
    channel?: { alternatives?: { transcript?: string; words?: Word[] }[] };
}

/** The reason a handshake failed, for people. */
function refusal(status: number): string {
    if (status === 401 || status === 403) return 'Speech recognition is unavailable (the plan’s key was refused). The owner has been told.';
    if (status === 402) return 'Speech recognition is unavailable (the plan is out of credit). The owner has been told.';
    if (status === 429) return 'Speech recognition is busy right now (too many requests at once).';
    return `Speech recognition is unavailable (error ${status}).`;
}

export function listenUrl(params: SpeechParams): string {
    const base = new URL('/v1/listen', env.DEEPGRAM_URL);
    const query = new URLSearchParams({
        model: SPEECH_MODEL,
        language: params.language,
        smart_format: 'true',
        punctuate: 'true',
        encoding: 'linear16',
        sample_rate: String(AUDIO.sampleRate),
        channels: '1',
        interim_results: 'true',
        vad_events: 'true',
        endpointing: String(ENDPOINTING_MS),
        utterance_end_ms: String(UTTERANCE_END_MS),
    });
    if (params.diarize) query.set('diarize', 'true');
    for (const term of params.terms.slice(0, MAX_TERMS)) query.append('keyterm', term);
    // `+` in a term would read as a space.
    return `${base.href}?${query.toString().replaceAll('+', '%20')}`;
}

export class SpeechStream {
    readonly channel: Channel;
    /** Seconds of audio sent to Deepgram so far (what it bills). */
    seconds = 0;
    readonly #params: SpeechParams;
    readonly #events: SpeechEvents;
    /** Seconds since the call began, now. */
    readonly #clock: () => number;
    #socket: WebSocket | undefined;
    #connecting = false;
    #closing = false;
    #attempt = 0;
    #reconnect: ReturnType<typeof setTimeout> | undefined;
    #keepAlive: ReturnType<typeof setInterval> | undefined;
    #lastSent = 0;
    /** The call's clock when this connection's first audio went out: Deepgram's times start at 0 there. */
    #origin: number | undefined;
    #speaking = false;
    #finals: { text: string; speakers: number[]; start: number; end: number }[] = [];
    #interim = '';
    #interimSpeakers: number[] = [];
    /** Where the utterance being said began, on the call's clock. */
    #utteranceStart: number | undefined;
    ok = false;

    constructor(channel: Channel, params: SpeechParams, events: SpeechEvents, clock: () => number) {
        this.channel = channel;
        this.#params = params;
        this.#events = events;
        this.#clock = clock;
    }

    /** Opens the stream (and keeps it open). Resolves when the first attempt has worked or failed. */
    async open(): Promise<void> {
        if (this.#closing || this.#connecting || this.#socket) return;
        this.#connecting = true;
        try {
            const response = await fetch(listenUrl(this.#params), {
                headers: { Upgrade: 'websocket', Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
            });
            const socket = response.webSocket;
            if (!socket) {
                // The handshake was refused: why, and try again later.
                this.#fail(refusal(response.status), 15_000);
                return;
            }
            socket.accept();
            socket.binaryType = 'arraybuffer';
            this.#socket = socket;
            this.#origin = undefined;
            socket.addEventListener('message', (event) => this.#message(event.data));
            socket.addEventListener('close', () => this.#lost(socket, 'the connection closed'));
            socket.addEventListener('error', () => this.#lost(socket, 'the connection failed'));
            this.#attempt = 0;
            this.#lastSent = Date.now();
            clearInterval(this.#keepAlive);
            this.#keepAlive = setInterval(() => {
                if (Date.now() - this.#lastSent >= KEEP_ALIVE_MS) this.#sendText('{"type":"KeepAlive"}');
            }, 1000);
            this.ok = true;
            this.#events.onState(true, '');
        } catch {
            this.#fail('Speech recognition stopped answering: it cannot be reached.', RECONNECT_MS[Math.min(this.#attempt++, RECONNECT_MS.length - 1)]!);
        } finally {
            this.#connecting = false;
        }
    }

    /** Audio for this channel: 16-bit little-endian PCM, mono. Lost while the stream is down. */
    send(pcm: ArrayBuffer): void {
        const socket = this.#socket;
        if (!socket || this.#closing) return;
        const seconds = pcm.byteLength / 2 / AUDIO.sampleRate;
        this.#origin ??= Math.max(0, this.#clock() - seconds);
        this.seconds += seconds;
        this.#lastSent = Date.now();
        try {
            socket.send(pcm);
        } catch {
            /* closing */
        }
    }

    /** Ends the stream: what Deepgram still holds comes out as final results first (at most `waitMs`). */
    async close(waitMs = 3000): Promise<void> {
        this.#closing = true;
        clearTimeout(this.#reconnect);
        clearInterval(this.#keepAlive);
        const socket = this.#socket;
        if (!socket) return;
        this.#sendText('{"type":"CloseStream"}');
        await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, waitMs);
            socket.addEventListener('close', () => {
                clearTimeout(timer);
                resolve();
            });
        });
        this.#flush();
        this.#socket = undefined;
        try {
            socket.close(1000, 'done');
        } catch {
            /* already closed */
        }
    }

    #sendText(text: string): void {
        try {
            this.#socket?.send(text);
        } catch {
            /* closing */
        }
    }

    /** The stream ended without our asking: open it again, telling the call speech recognition is down meanwhile. */
    #lost(socket: WebSocket, why: string): void {
        if (this.#closing || this.#socket !== socket) return;
        this.#socket = undefined;
        clearInterval(this.#keepAlive);
        this.#flush();
        this.#fail(`Speech recognition stopped answering: ${why}.`, RECONNECT_MS[Math.min(this.#attempt++, RECONNECT_MS.length - 1)]!);
    }

    #fail(detail: string, retryMs: number): void {
        this.ok = false;
        this.#events.onState(false, detail);
        if (this.#closing) return;
        clearTimeout(this.#reconnect);
        this.#reconnect = setTimeout(() => void this.open(), retryMs);
    }

    #message(data: string | ArrayBuffer): void {
        if (typeof data !== 'string') return;
        let message: Results;
        try {
            message = JSON.parse(data) as Results;
        } catch {
            return;
        }
        if (message.type === 'SpeechStarted') return this.#speak(true);
        if (message.type === 'UtteranceEnd') return this.#flush();
        if (message.type !== 'Results') return;
        const alternative = message.channel?.alternatives?.[0];
        const text = (alternative?.transcript ?? '').trim();
        const start = this.#seconds(message.start ?? 0);
        const end = this.#seconds((message.start ?? 0) + (message.duration ?? 0));
        const speakers = (alternative?.words ?? []).flatMap((word) => (word.speaker === undefined ? [] : [word.speaker]));
        if (text !== '') this.#utteranceStart ??= start;
        if (message.is_final) {
            if (text !== '') this.#finals.push({ text, speakers, start, end });
            this.#interim = '';
            this.#interimSpeakers = [];
        } else {
            this.#interim = text;
            this.#interimSpeakers = speakers;
        }
        if (text !== '') this.#speak(true);
        if (message.speech_final) return this.#flush();
        const sofar = this.#sofar();
        if (sofar) this.#events.onPartial(sofar.text, sofar.speaker, sofar.start, Math.max(sofar.end, end));
    }

    /** Deepgram's time, on the call's clock. */
    #seconds(time: number): number {
        return (this.#origin ?? this.#clock()) + time;
    }

    #sofar(): { text: string; speaker: number | null; start: number; end: number } | undefined {
        const text = [...this.#finals.map((item) => item.text), this.#interim].filter((part) => part !== '').join(' ');
        if (text === '') return undefined;
        const last = this.#finals.at(-1);
        // The voice that spoke most of the words, counted from 1.
        const counts = new Map<number, number>();
        for (const speaker of [...this.#finals.flatMap((item) => item.speakers), ...this.#interimSpeakers]) counts.set(speaker, (counts.get(speaker) ?? 0) + 1);
        const loudest = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        return {
            text,
            speaker: this.#params.diarize && loudest !== undefined ? loudest + 1 : null,
            start: this.#utteranceStart ?? this.#seconds(0),
            end: last?.end ?? this.#utteranceStart ?? this.#seconds(0),
        };
    }

    /** The utterance is over: what Deepgram made final is the line. */
    #flush(): void {
        const line = this.#finals.length > 0 ? this.#sofar() : undefined;
        const stamp = line ?? { text: '', speaker: null, start: this.#clock(), end: this.#clock() };
        this.#finals = [];
        this.#interim = '';
        this.#interimSpeakers = [];
        this.#utteranceStart = undefined;
        if (!this.#speaking && !line) return;
        this.#speak(false);
        this.#events.onFinal(stamp.text, stamp.speaker, stamp.start, stamp.end);
    }

    #speak(active: boolean): void {
        if (this.#speaking === active) return;
        this.#speaking = active;
        this.#events.onSpeaking(active);
    }
}
