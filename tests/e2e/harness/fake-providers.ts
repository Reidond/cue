// Stand-ins for the paid cloud services the Cue backend calls: the Anthropic Messages API and Deepgram's speech-to-text (live streams and recorded files), served on 127.0.0.1
// from the case's own process. They are the backend's upstreams (`ANTHROPIC_URL`, `DEEPGRAM_URL`), with the owner's keys the case gives the backend
// (`FAKE_KEYS`): Cue itself never talks to them.
//
// They note what the backend sent in the case's claude folder (see `Cue.claudeRequests` and `Cue.serviceRequests`), and the Anthropic one replies
// as fake-replies.ts says, from the FAKE_CLAUDE_* variables of the Cue running (or of `cue.standIns`). They take only the keys in FAKE_KEYS: any
// other one is rejected (401).
//
//   /v1/messages   answers, verdicts, names and summaries; `max_tokens: 0` warms the cache (answer-system, judge-system), a question is `ask` or
//                  `judge`, a transcript `summary-system` and `summary-input` (the notes Workflow's summary) or, when the system prompt starts "You find
//                  the names", `names-system` and `names-input`; each request also as `anthropic-request`, with the headers it came with.
//                  Replies carry `usage` and simulate the prompt cache (a system prompt seen before is a cache read). FAKE_CLAUDE_JUDGE_FAILS=1
//                  fails every judge request with a 500, FAKE_ANTHROPIC_OVERLOADED=N the first N judge requests with a 529 (overloaded),
//                  FAKE_ANTHROPIC_CUT=N breaks off the first N streamed answers after their first words (no `message_stop`), FAKE_CLAUDE_JUDGE_DELAY
//                  and FAKE_CLAUDE_SUMMARY_DELAY (seconds) slow them down, FAKE_ANTHROPIC_SUMMARY_FAILS=N fails the first N summary requests with a
//                  500. The names reply is FAKE_CLAUDE_NAMES (a JSON object, label → name) as `<!-- speaker: LABEL = NAME -->` lines, else the
//                  speaker lines of the FAKE_CLAUDE_SUMMARY file.
//   /v1/listen     WebSocket: a live stream, one per channel, of 16-bit PCM. Speech is told from silence by loudness (20 ms frames), and each
//                  stretch of speech is an utterance: SpeechStarted, an interim result every 0.2 s, and the final once the silence has lasted
//                  `endpointing` ms. Its text is the next line of FAKE_DEEPGRAM_LIVE (a JSON array, one entry per utterance in the order they start,
//                  across both channels; an entry is a string, or {text, speaker} for the call side with `diarize`), or "Utterance N." (too short
//                  to pass for an echo of the other side). FAKE_DEEPGRAM_DROP=N drops the connection of the Nth utterance as it starts, as a lost
//                  connection would. A stream with no audio for 10 s is closed, as Deepgram does without KeepAlive. Noted as `deepgram-live`.
//   /v1/listen     POST: a recorded file (the notes Workflow's second pass), a 16-bit WAV as the body, `tag` = the side (`me`, `others`). One
//                  utterance per stretch of speech in it (20 ms frames above the silence threshold, pauses under half a second bridged), with
//                  words spread over it, and with `diarize` each word and utterance has a `speaker`. Its text is the side's next entry of
//                  FAKE_DEEPGRAM_FILE (a JSON object `{"me": […], "others": […]}`; an entry is a string, or {text, speaker} on the call side;
//                  a side's array is complete: stretches past its end, and entries with no text, get no utterance), or "Second pass by Deepgram,
//                  part N." for a side the object does not have. FAKE_DEEPGRAM_FILE_FAILS=N fails the first N recorded requests with a 500,
//                  FAKE_DEEPGRAM_FILE_DELAY (seconds) slows each down. Noted as `deepgram-file`.
//   /markdown      POST: Workers AI `toMarkdown`, for the Cue API (MARKDOWN_URL). A Word file's paragraphs or a PDF's text, one blank line
//                  apart, as `{name, format: 'markdown', data, tokens}`; any other file as `{format: 'error'}`, the shape `toMarkdown` returns
//                  per file. The file's name arrives in `x-file-name` (URL-encoded). Noted as `markdown-request`.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { unzip } from './documents.ts';
import { answer, judgement, names, pieces, record, summary, type Env } from '../tools/fake-replies.ts';

/** The only keys the stand-ins take. */
export const FAKE_KEYS = { anthropic: 'sk-ant-e2e-fake-key', deepgram: 'dg-e2e-fake-key' } as const;

/** What the Anthropic stand-in noted about a request. */
export interface AnthropicRequest {
    kind: 'answer' | 'judge' | 'summary' | 'names';
    key: string;
    version: string;
    model: string;
    maxTokens: number;
    stream: boolean;
    thinking?: { type: string };
    /** Top-level automatic caching. */
    cache?: { type: string; ttl?: string };
    /** The breakpoint on the system prompt. */
    systemCache?: { type: string; ttl?: string };
    messages: number;
    /** The request's headers (lower-case names): the owner's key in `x-api-key`, and nothing of the user's. */
    headers: Record<string, string>;
}

/** What the `toMarkdown` stand-in noted about a file the Cue API sent it. */
export interface MarkdownRequest {
    name: string;
    contentType: string;
    bytes: number;
}

/** The paragraphs of a Word file, or the text of a PDF's show-text operators, as Markdown. */
function markdownOf(name: string, file: Buffer): string | undefined {
    try {
        if (/\.docx$/i.test(name)) {
            const xml = unzip(file)['word/document.xml'] ?? '';
            const unescape = (text: string) => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
            return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)]
                .map((paragraph) => unescape([...paragraph[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((run) => run[1]).join('')))
                .join('\n\n');
        }
        if (/\.pdf$/i.test(name)) {
            return [...file.toString('latin1').matchAll(/\(((?:\\.|[^\\)])*)\)\s*Tj/g)]
                .map((shown) => shown[1]!.replace(/\\(.)/g, '$1'))
                .join('\n\n');
        }
    } catch {
        /* not a file of that kind */
    }
    return undefined;
}

/** What the Deepgram stand-in noted about a live stream: the query, the key, the audio. */
export interface DeepgramRequest {
    query: Record<string, string>;
    keyterms: string[];
    key: string;
    /** The request's headers (lower-case names). */
    headers: Record<string, string>;
    /** Which side it carried: the call's audio has `diarize`. */
    side: 'me' | 'others';
    /** Seconds of audio received. */
    seconds: number;
    messages: number;
    /** Whether the backend ended the stream with CloseStream. */
    closed: boolean;
    /** How many KeepAlive messages it sent. */
    keepAlives: number;
    /** Dropped on purpose (FAKE_DEEPGRAM_DROP). */
    dropped?: boolean;
}

/** What the Deepgram stand-in noted about a recorded file (the notes Workflow's second pass): the query, the key, the audio. */
export interface DeepgramFileRequest {
    query: Record<string, string>;
    keyterms: string[];
    key: string;
    /** The request's headers (lower-case names). */
    headers: Record<string, string>;
    /** Which side it carried: its `tag`. */
    side: string;
    /** Seconds of audio received (0 when it was not a WAV file). */
    seconds: number;
    bytes: number;
    contentType: string;
    /** The stretches of speech it found in the audio, in seconds: where each utterance starts and ends. */
    heard: [number, number][];
    /** Failed on purpose (FAKE_DEEPGRAM_FILE_FAILS). */
    failed?: boolean;
}

export interface FakeProviders {
    /** ANTHROPIC_URL and DEEPGRAM_URL of the backend: both are this one server. */
    url: string;
    close(): Promise<void>;
}

function body(request: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
    });
}

function json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
}

function textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    return Array.isArray(content)
        ? content.map((block: { text?: string } | string) => (typeof block === 'string' ? block : (block.text ?? ''))).join('')
        : '';
}

function queryOf(url: URL): { query: Record<string, string>; keyterms: string[] } {
    const query: Record<string, string> = {};
    for (const [name, value] of url.searchParams) if (name !== 'keyterm') query[name] = value;
    return { query, keyterms: url.searchParams.getAll('keyterm') };
}

function headersOf(request: IncomingMessage): Record<string, string> {
    return Object.fromEntries(
        Object.entries(request.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : (value ?? '')]),
    );
}

/** Deepgram's `Authorization: Token KEY`. */
function deepgramKey(request: IncomingMessage): string {
    return /^Token (.*)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
}

/** The samples of a WAV file (16-bit or float PCM, the first channel), and its rate. */
function samplesOf(wav: Buffer): { rate: number; samples: Float32Array } | undefined {
    if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return undefined;
    let offset = 12,
        rate = 16000,
        bits = 16,
        channels = 1,
        float = false;
    while (offset + 8 <= wav.length) {
        const id = wav.toString('ascii', offset, offset + 4),
            size = wav.readUInt32LE(offset + 4);
        if (id === 'fmt ') {
            float = wav.readUInt16LE(offset + 8) === 3;
            channels = wav.readUInt16LE(offset + 10);
            rate = wav.readUInt32LE(offset + 12);
            bits = wav.readUInt16LE(offset + 22);
        } else if (id === 'data') {
            const data = wav.subarray(offset + 8, Math.min(wav.length, offset + 8 + size));
            const step = (bits / 8) * channels,
                count = Math.floor(data.length / step);
            const samples = new Float32Array(count);
            for (let index = 0; index < count; index++) {
                samples[index] = float ? data.readFloatLE(index * step) : data.readInt16LE(index * step) / 32768;
            }
            return { rate, samples };
        }
        offset += 8 + size + (size % 2);
    }
    return undefined;
}

/** Stretches of speech, in seconds: 20 ms frames well above silence, pauses under half a second bridged. */
function stretches(rate: number, samples: Float32Array): [number, number][] {
    const frame = Math.round(rate / 50),
        found: [number, number][] = [];
    let start: number | undefined,
        last = 0;
    for (let index = 0; index * frame < samples.length; index++) {
        let sum = 0;
        const end = Math.min(samples.length, (index + 1) * frame);
        for (let at = index * frame; at < end; at++) sum += samples[at]! * samples[at]!;
        if (Math.sqrt(sum / (end - index * frame)) < 0.01) continue;
        if (start !== undefined && index - last > 25) {
            if (last + 1 - start >= 15) found.push([start / 50, (last + 1) / 50]);
            start = undefined;
        }
        start ??= index;
        last = index;
    }
    if (start !== undefined && last + 1 - start >= 15) found.push([start / 50, (last + 1) / 50]);
    return found;
}

// MARK: WebSocket, as much of RFC 6455 as a live stream needs

function frame(opcode: number, payload: Buffer): Buffer {
    const length = payload.length;
    const header =
        length < 126
            ? Buffer.from([0x80 | opcode, length])
            : length < 65536
              ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
              : Buffer.concat([
                    Buffer.from([0x80 | opcode, 127]),
                    (() => {
                        const size = Buffer.alloc(8);
                        size.writeBigUInt64BE(BigInt(length));
                        return size;
                    })(),
                ]);
    return Buffer.concat([header, payload]);
}

/** Reads the client's frames as they come, whole messages to `onMessage`. */
function frames(socket: Duplex, head: Buffer, onMessage: (opcode: number, payload: Buffer) => void): void {
    let buffer = head,
        fragments: Buffer[] = [],
        fragmentOpcode = 0;
    const take = (): void => {
        for (;;) {
            if (buffer.length < 2) return;
            const fin = (buffer[0]! & 0x80) !== 0,
                opcode = buffer[0]! & 0x0f,
                masked = (buffer[1]! & 0x80) !== 0;
            let length = buffer[1]! & 0x7f,
                offset = 2;
            if (length === 126) {
                if (buffer.length < 4) return;
                length = buffer.readUInt16BE(2);
                offset = 4;
            } else if (length === 127) {
                if (buffer.length < 10) return;
                length = Number(buffer.readBigUInt64BE(2));
                offset = 10;
            }
            const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
            if (masked) offset += 4;
            if (buffer.length < offset + length) return;
            const payload = Buffer.from(buffer.subarray(offset, offset + length));
            if (mask) for (let index = 0; index < payload.length; index++) payload[index]! ^= mask[index % 4]!;
            buffer = buffer.subarray(offset + length);
            if (opcode >= 8) {
                onMessage(opcode, payload);
            } else if (!fin) {
                if (opcode !== 0) fragmentOpcode = opcode;
                fragments.push(payload);
            } else if (opcode === 0) {
                onMessage(fragmentOpcode, Buffer.concat([...fragments, payload]));
                fragments = [];
            } else {
                onMessage(opcode, payload);
            }
        }
    };
    socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        take();
    });
    take();
}

/** Starts the stand-ins; `log` is where they note requests, `env` the environment of the Cue running. */
export async function startFakeProviders(log: string, env: () => Env): Promise<FakeProviders> {
    let utterances = 0,
        judged = 0,
        answered = 0,
        summaries = 0,
        filed = 0;
    /** The system prompts the prompt cache has seen. */
    const caches = new Set<string>();
    const sockets = new Set<Socket | Duplex>();

    async function anthropic(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const sent = JSON.parse((await body(request)).toString('utf8')) as Record<string, unknown>;
        const system = textOf(sent['system']);
        const messages = (sent['messages'] ?? []) as { content: unknown }[];
        const content = textOf(messages.at(-1)?.content);
        const kind: AnthropicRequest['kind'] = content.startsWith('Transcript:')
            ? system.startsWith('You find the names')
                ? 'names'
                : 'summary'
            : system.startsWith('You watch the live transcript')
              ? 'judge'
              : 'answer';
        const key = String(request.headers['x-api-key'] ?? '');
        const noted: AnthropicRequest = {
            kind,
            key,
            version: String(request.headers['anthropic-version'] ?? ''),
            model: String(sent['model']),
            maxTokens: Number(sent['max_tokens']),
            stream: sent['stream'] === true,
            thinking: sent['thinking'] as AnthropicRequest['thinking'],
            cache: sent['cache_control'] as AnthropicRequest['cache'],
            systemCache: Array.isArray(sent['system'])
                ? (sent['system'][0] as { cache_control?: AnthropicRequest['cache'] }).cache_control
                : undefined,
            messages: messages.length,
            headers: headersOf(request),
        };
        record(log, 'anthropic-request', JSON.stringify(noted));
        const environment = env();
        if (key !== FAKE_KEYS.anthropic) {
            return json(response, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        }
        if (kind === 'judge' && environment['FAKE_CLAUDE_JUDGE_FAILS'] === '1') {
            return json(response, 500, { type: 'error', error: { type: 'api_error', message: 'The judge failed' } });
        }
        if (kind === 'judge' && ++judged <= Number(environment['FAKE_ANTHROPIC_OVERLOADED'] ?? 0)) {
            return json(response, 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
        }
        if (kind === 'summary' && noted.maxTokens !== 0 && ++summaries <= Number(environment['FAKE_ANTHROPIC_SUMMARY_FAILS'] ?? 0)) {
            return json(response, 500, { type: 'error', error: { type: 'api_error', message: 'The summary failed' } });
        }
        // The prompt cache: a system prompt with a breakpoint is written the first time it is seen and read after that.
        const systemTokens = Math.ceil(system.length / 4);
        const cached = noted.systemCache !== undefined;
        const cacheKey = `${noted.model}\u0000${system}`;
        const usage = (output: string) => {
            const seen = caches.has(cacheKey);
            if (cached) caches.add(cacheKey);
            const total = systemTokens + Math.ceil(textOf(messages.map((message) => message.content)).length / 4);
            return {
                input_tokens: cached ? total - systemTokens : total,
                output_tokens: Math.ceil(output.length / 4),
                cache_creation_input_tokens: cached && !seen ? systemTokens : 0,
                cache_read_input_tokens: cached && seen ? systemTokens : 0,
            };
        };
        if (noted.maxTokens === 0) {
            record(log, kind === 'judge' ? 'judge-system' : 'answer-system', system);
            return json(response, 200, { type: 'message', role: 'assistant', content: [], stop_reason: 'max_tokens', usage: usage('') });
        }
        let text: string;
        if (kind === 'summary') {
            record(log, 'summary-system', system);
            record(log, 'summary-input', content);
            const delay = Number(environment['FAKE_CLAUDE_SUMMARY_DELAY']);
            if (delay > 0) await sleep(delay * 1000);
            text = summary(environment);
        } else if (kind === 'names') {
            record(log, 'names-system', system);
            record(log, 'names-input', content);
            text = names(environment);
        } else if (kind === 'judge') {
            record(log, 'judge', content);
            const delay = Number(environment['FAKE_CLAUDE_JUDGE_DELAY']);
            if (delay > 0) await sleep(delay * 1000);
            text = judgement(content, environment);
        } else {
            record(log, 'ask', content);
            text = answer(content, environment);
        }
        if (!noted.stream) {
            return json(response, 200, {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'text', text }],
                stop_reason: 'end_turn',
                usage: usage(text),
            });
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const event = (type: string, data: object): boolean =>
            response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        const used = usage(text);
        event('message_start', {
            message: {
                type: 'message',
                role: 'assistant',
                model: noted.model,
                content: [],
                stop_reason: null,
                usage: { ...used, output_tokens: 1 },
            },
        });
        event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        if (kind === 'answer' && ++answered <= Number(environment['FAKE_ANTHROPIC_CUT'] ?? 0)) {
            event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: pieces(text)[0] ?? '' } });
            response.end();
            return;
        }
        for (const piece of pieces(text)) event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } });
        event('content_block_stop', { index: 0 });
        event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: used.output_tokens } });
        event('message_stop', {});
        response.end();
    }

    /** A recorded file: one utterance per stretch of speech in it, saying what FAKE_DEEPGRAM_FILE has for that side. */
    async function deepgramFile(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
        const audio = await body(request);
        const decoded = samplesOf(audio);
        const key = deepgramKey(request);
        const { query, keyterms } = queryOf(url);
        const environment = env();
        const side = query['tag'] ?? (query['diarize'] === 'true' ? 'others' : 'me');
        const noted = (extra: Partial<DeepgramFileRequest>): string =>
            JSON.stringify({
                query,
                keyterms,
                key,
                headers: headersOf(request),
                side,
                seconds: decoded ? decoded.samples.length / decoded.rate : 0,
                bytes: audio.length,
                contentType: String(request.headers['content-type'] ?? ''),
                heard: decoded ? stretches(decoded.rate, decoded.samples) : [],
                ...extra,
            } satisfies DeepgramFileRequest);
        if (key !== FAKE_KEYS.deepgram) {
            record(log, 'deepgram-file', noted({}));
            return json(response, 401, { err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' });
        }
        const delay = Number(environment['FAKE_DEEPGRAM_FILE_DELAY']);
        if (delay > 0) await sleep(delay * 1000);
        if (++filed <= Number(environment['FAKE_DEEPGRAM_FILE_FAILS'] ?? 0)) {
            record(log, 'deepgram-file', noted({ failed: true }));
            return json(response, 500, { err_code: 'INTERNAL_SERVER_ERROR', err_msg: 'The recorded-file stand-in was told to fail.' });
        }
        record(log, 'deepgram-file', noted({}));
        if (!decoded) return json(response, 400, { err_code: 'Bad Request', err_msg: 'Bad Request: failed to process audio' });

        const diarize = query['diarize'] === 'true';
        const scripts = JSON.parse(environment['FAKE_DEEPGRAM_FILE'] ?? '{}') as Record<
            string,
            (string | { text: string; speaker?: number })[]
        >;
        const script = scripts[side];
        const found = stretches(decoded.rate, decoded.samples);
        const utterances = found.flatMap(([start, end], index) => {
            const entry = script === undefined ? `Second pass by Deepgram, part ${index + 1}.` : script[index];
            const text = typeof entry === 'string' ? entry : (entry?.text ?? '');
            if (text === '') return [];
            const speaker = typeof entry === 'object' ? (entry.speaker ?? 0) : 0;
            const spoken = text.split(' ');
            const words = spoken.map((word, at) => ({
                word: word.toLowerCase().replace(/[.,!?…]+$/, ''),
                punctuated_word: word,
                start: start + ((end - start) * at) / spoken.length,
                end: start + ((end - start) * (at + 1)) / spoken.length,
                confidence: 0.99,
                ...(diarize ? { speaker } : {}),
            }));
            return [{ start, end, confidence: 0.99, channel: 0, transcript: text, words, ...(diarize ? { speaker } : {}) }];
        });
        json(response, 200, {
            metadata: { duration: decoded.samples.length / decoded.rate, channels: 1, model_info: { name: query['model'] ?? 'nova-3' } },
            results: {
                channels: [
                    {
                        alternatives: [
                            {
                                transcript: utterances.map((item) => item.transcript).join(' '),
                                confidence: 0.99,
                                words: utterances.flatMap((item) => item.words),
                            },
                        ],
                    },
                ],
                utterances,
            },
        });
    }

    /** One live stream of one channel: PCM in, SpeechStarted, interim results and finals out. */
    function deepgramLive(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
        const key = deepgramKey(request);
        const { query, keyterms } = queryOf(url);
        const side = query['diarize'] === 'true' ? 'others' : 'me';
        const noted = (extra: Partial<DeepgramRequest>): string =>
            JSON.stringify({
                query,
                keyterms,
                key,
                headers: headersOf(request),
                side,
                seconds: 0,
                messages: 0,
                closed: false,
                keepAlives: 0,
                ...extra,
            } satisfies DeepgramRequest);
        if (key !== FAKE_KEYS.deepgram) {
            record(log, 'deepgram-live', noted({}));
            socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n');
            return;
        }
        const accept = createHash('sha1')
            .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64');
        socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        const rate = Number(query['sample_rate'] ?? 16000);
        const frameBytes = (rate / 50) * 2;
        const endpointing = Number(query['endpointing'] ?? 700);
        const vadEvents = query['vad_events'] === 'true';
        const diarize = query['diarize'] === 'true';
        let bytes = 0,
            messages = 0,
            keepAlives = 0,
            done = false,
            closed = false;
        let pending = Buffer.alloc(0);
        let voicedRun = 0,
            silentRun = 0,
            speechFrames = 0,
            sinceInterim = 0;
        let speaking = false,
            started = 0,
            counted = false,
            said: { text: string; speaker: number } | undefined;
        let idle: NodeJS.Timeout | undefined;
        const send = (value: object): void => void socket.write(frame(1, Buffer.from(JSON.stringify(value))));
        const finish = (dropped = false): void => {
            if (done) return;
            done = true;
            clearTimeout(idle);
            record(log, 'deepgram-live', noted({ seconds: bytes / 2 / rate, messages, closed, keepAlives, dropped: dropped || undefined }));
        };
        // Deepgram closes a stream that gets neither audio nor KeepAlive for 10 s.
        const touch = (): void => {
            clearTimeout(idle);
            idle = setTimeout(() => {
                send({ type: 'Error', description: 'Did not receive audio or KeepAlive within 10 seconds' });
                socket.write(frame(8, Buffer.from([0x03, 0xf3])));
                finish();
                socket.end();
            }, 10_000);
        };
        touch();
        const result = (text: string, final: boolean, speaker: number): void => {
            const words = text.split(' ').map((word) => ({ word, speaker }));
            send({
                type: 'Results',
                is_final: final,
                speech_final: final,
                start: started,
                duration: Math.max(0, bytes / 2 / rate - started),
                channel: { alternatives: [{ transcript: text, confidence: 0.99, words: diarize ? words : [] }] },
            });
        };
        const endUtterance = (): void => {
            if (speaking && counted && said) result(said.text, true, said.speaker);
            speaking = false;
            counted = false;
            said = undefined;
            voicedRun = silentRun = speechFrames = sinceInterim = 0;
        };
        const onFrame = (samples: Buffer): void => {
            let sum = 0;
            for (let index = 0; index < samples.length; index += 2) {
                const value = samples.readInt16LE(index) / 32768;
                sum += value * value;
            }
            const voiced = Math.sqrt(sum / (samples.length / 2)) > 0.01;
            if (!speaking) {
                voicedRun = voiced ? voicedRun + 1 : 0;
                if (voicedRun < 4) return;
                speaking = true;
                started = Math.max(0, bytes / 2 / rate - voicedRun * 0.02);
                speechFrames = voicedRun;
                silentRun = 0;
                sinceInterim = 0;
                if (vadEvents) send({ type: 'SpeechStarted', channel: [0, 1], timestamp: started });
                return;
            }
            if (voiced) {
                speechFrames++;
                silentRun = 0;
            } else {
                silentRun++;
            }
            sinceInterim++;
            // Blips shorter than 400 ms are no utterance.
            if (!counted && speechFrames >= 20) {
                counted = true;
                const number = ++utterances;
                // Read now, so that a case can change what the stand-in says between utterances.
                const environment = env();
                const entries = JSON.parse(environment['FAKE_DEEPGRAM_LIVE'] ?? '[]') as (string | { text: string; speaker?: number })[];
                if (number === Number(environment['FAKE_DEEPGRAM_DROP'] ?? 0)) {
                    finish(true);
                    socket.destroy();
                    return;
                }
                const entry = entries[number - 1];
                said = {
                    text: typeof entry === 'string' ? entry : (entry?.text ?? `Utterance ${number}.`),
                    speaker: typeof entry === 'object' ? (entry.speaker ?? 0) : 0,
                };
            }
            if (counted && said && sinceInterim >= 10) {
                sinceInterim = 0;
                const words = said.text.split(' ');
                const shown = Math.max(1, Math.min(words.length - 1, Math.ceil(speechFrames / 10)));
                if (words.length > 1) result(words.slice(0, shown).join(' '), false, said.speaker);
            }
            if (silentRun * 20 >= endpointing || speechFrames >= 1250) endUtterance();
        };
        frames(socket, head, (opcode, payload) => {
            if (opcode === 2) {
                touch();
                messages++;
                bytes += payload.length;
                pending = Buffer.concat([pending, payload]);
                while (pending.length >= frameBytes) {
                    onFrame(pending.subarray(0, frameBytes));
                    pending = pending.subarray(frameBytes);
                    if (done) return;
                }
            } else if (opcode === 1) {
                const text = payload.toString('utf8');
                if (/"KeepAlive"/.test(text)) {
                    keepAlives++;
                    touch();
                } else if (/"CloseStream"/.test(text)) {
                    closed = true;
                    endUtterance();
                    send({ type: 'Metadata', duration: bytes / 2 / rate, channels: 1 });
                    socket.write(frame(8, Buffer.from([0x03, 0xe8])));
                    finish();
                    socket.end();
                }
            } else if (opcode === 8) {
                finish();
                socket.end(frame(8, Buffer.from([0x03, 0xe8])));
            } else if (opcode === 9) {
                socket.write(frame(10, payload));
            }
        });
        socket.on('close', () => finish());
        socket.on('error', () => finish());
    }

    async function markdown(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const file = await body(request);
        const name = decodeURIComponent(String(request.headers['x-file-name'] ?? 'file'));
        record(
            log,
            'markdown-request',
            JSON.stringify({
                name,
                contentType: String(request.headers['content-type'] ?? ''),
                bytes: file.length,
            } satisfies MarkdownRequest),
        );
        const data = markdownOf(name, file);
        json(
            response,
            200,
            data === undefined
                ? { name, format: 'error', data: '', error: 'This file could not be converted.' }
                : { name, format: 'markdown', data, tokens: Math.ceil(data.length / 4) },
        );
    }

    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const handled =
            request.method === 'POST' && url.pathname === '/v1/messages'
                ? anthropic(request, response)
                : request.method === 'POST' && url.pathname === '/v1/listen'
                  ? deepgramFile(request, response, url)
                  : request.method === 'POST' && url.pathname === '/markdown'
                    ? markdown(request, response)
                    : Promise.resolve(json(response, 404, { error: `no ${request.method} ${url.pathname} here` }));
        handled.catch((error: unknown) => {
            if (!response.headersSent) json(response, 500, { type: 'error', error: { type: 'api_error', message: String(error) } });
            else response.end();
        });
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        if (url.pathname === '/v1/listen') deepgramLive(request, socket, head, url);
        else socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise<void>((resolve) => {
                for (const socket of sockets) socket.destroy();
                server.close(() => resolve());
            }),
    };
}
