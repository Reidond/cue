// Stand-ins for the paid cloud services Cue can use (Settings › Providers): the Anthropic Messages API
// and Deepgram's speech-to-text, served on 127.0.0.1 from the case's own process. Cue reaches them through
// CUE_ANTHROPIC_URL and CUE_DEEPGRAM_URL; with `run.ts --real-anthropic` / `--real-deepgram` it goes to
// the real ones instead.
//
// Like the fake claude, they note what Cue sent in the case's claude folder (see `Cue.claudeRequests`
// and `Cue.serviceRequests`), and the Anthropic one replies as fake-replies.ts says, from the FAKE_CLAUDE_*
// variables of the Cue running. They take only the keys in FAKE_KEYS: any other one is rejected (401).
//
//   /v1/messages   answers, verdicts and summaries; `max_tokens: 0` warms the cache (answer-system,
//                  judge-system), a question is `ask` or `judge`, a transcript `summary-system` and
//                  `summary-input`; each request also as `anthropic-request`. FAKE_CLAUDE_JUDGE_FAILS=1
//                  fails every judge request with a 500, FAKE_ANTHROPIC_OVERLOADED=N the first N judge
//                  requests with a 529 (overloaded), FAKE_ANTHROPIC_CUT=N breaks off the first N streamed
//                  answers after their first words (no `message_stop`), FAKE_CLAUDE_JUDGE_DELAY and
//                  FAKE_CLAUDE_SUMMARY_DELAY (seconds) slow them down.
//   /v1/listen     WebSocket: a live stream, one per utterance. Every audio message gets an interim result,
//                  CloseStream the final one, then the socket closes. The text is the next line of
//                  FAKE_DEEPGRAM_LIVE (a JSON array, one line per stream that gets audio, in that order), or
//                  "Utterance N." (too short to pass for an echo of the other side); FAKE_DEEPGRAM_DROP=N
//                  drops the Nth such stream at its first audio, as a lost connection would. Noted as
//                  `deepgram-live`.
//   /v1/listen     POST: a recorded file. One utterance per stretch of speech in it, "Second pass by Deepgram,
//                  part N.", at its times. Noted as `deepgram-file`.
//   /v1/projects   GET: the key check.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { answer, judgement, pieces, record, summary, type Env } from '../tools/fake-replies.ts';

/** The only keys the stand-ins take. */
export const FAKE_KEYS = { anthropic: 'sk-ant-e2e-fake-key', deepgram: 'dg-e2e-fake-key' } as const;

/** What the Anthropic stand-in noted about a request. */
export interface AnthropicRequest {
    kind: 'answer' | 'judge' | 'summary';
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
}

/** What the Deepgram stand-in noted about a stream or a file: the query, the key, the audio. */
export interface DeepgramRequest {
    query: Record<string, string>;
    keyterms: string[];
    key: string;
    /** Seconds of audio received. */
    seconds: number;
    /** Live: the audio messages, and whether Cue ended the stream with CloseStream. */
    messages?: number;
    closed?: boolean;
    /** Live: seconds from the stream opening to its first audio. */
    waited?: number;
    /** Live: dropped on purpose (FAKE_DEEPGRAM_DROP). */
    dropped?: boolean;
    /** File: its Content-Type. */
    contentType?: string;
}

export interface FakeProviders {
    /** CUE_ANTHROPIC_URL and CUE_DEEPGRAM_URL: both are this one server. */
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
    return Array.isArray(content) ? content.map((block: { text?: string }) => block.text ?? '').join('') : '';
}

function queryOf(url: URL): { query: Record<string, string>; keyterms: string[] } {
    const query: Record<string, string> = {};
    for (const [name, value] of url.searchParams) if (name !== 'keyterm') query[name] = value;
    return { query, keyterms: url.searchParams.getAll('keyterm') };
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
    let streams = 0,
        judged = 0,
        answered = 0;
    const sockets = new Set<Socket | Duplex>();

    async function anthropic(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const sent = JSON.parse((await body(request)).toString('utf8')) as Record<string, unknown>;
        const system = textOf(sent['system']);
        const messages = (sent['messages'] ?? []) as { content: unknown }[];
        const content = textOf(messages.at(-1)?.content);
        const kind = content.startsWith('Transcript:')
            ? 'summary'
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
        if (noted.maxTokens === 0) {
            record(log, kind === 'judge' ? 'judge-system' : 'answer-system', system);
            return json(response, 200, { type: 'message', role: 'assistant', content: [], stop_reason: 'max_tokens' });
        }
        let text: string;
        if (kind === 'summary') {
            record(log, 'summary-system', system);
            record(log, 'summary-input', content);
            const delay = Number(environment['FAKE_CLAUDE_SUMMARY_DELAY']);
            if (delay > 0) await sleep(delay * 1000);
            text = summary(environment);
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
            return json(response, 200, { type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'end_turn' });
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const event = (type: string, data: object): boolean =>
            response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        event('message_start', { message: { type: 'message', role: 'assistant', model: noted.model, content: [], stop_reason: null } });
        event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
        if (kind === 'answer' && ++answered <= Number(environment['FAKE_ANTHROPIC_CUT'] ?? 0)) {
            event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: pieces(text)[0] ?? '' } });
            response.end();
            return;
        }
        for (const piece of pieces(text)) event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } });
        event('content_block_stop', { index: 0 });
        event('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: text.split(' ').length } });
        event('message_stop', {});
        response.end();
    }

    async function deepgramFile(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
        const audio = await body(request);
        const decoded = samplesOf(audio);
        const key = deepgramKey(request);
        record(
            log,
            'deepgram-file',
            JSON.stringify({
                ...queryOf(url),
                key,
                seconds: decoded ? decoded.samples.length / decoded.rate : 0,
                contentType: request.headers['content-type'] ?? '',
            } satisfies DeepgramRequest),
        );
        if (key !== FAKE_KEYS.deepgram) return json(response, 401, { err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' });
        if (!decoded) return json(response, 400, { err_code: 'Bad Request', err_msg: 'Bad Request: failed to process audio' });
        const utterances = stretches(decoded.rate, decoded.samples).map(([start, end], index) => ({
            start,
            end,
            transcript: `Second pass by Deepgram, part ${index + 1}.`,
        }));
        json(response, 200, {
            metadata: { duration: decoded.samples.length / decoded.rate, channels: 1 },
            results: { channels: [{ alternatives: [{ transcript: utterances.map((item) => item.transcript).join(' ') }] }], utterances },
        });
    }

    function deepgramLive(request: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void {
        const key = deepgramKey(request);
        if (key !== FAKE_KEYS.deepgram) {
            record(
                log,
                'deepgram-live',
                JSON.stringify({ ...queryOf(url), key, seconds: 0, messages: 0, closed: false } satisfies DeepgramRequest),
            );
            socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n');
            return;
        }
        const accept = createHash('sha1')
            .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
            .digest('base64');
        socket.write(
            `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        const environment = env();
        const lines = JSON.parse(environment['FAKE_DEEPGRAM_LIVE'] ?? '[]') as string[];
        const rate = Number(url.searchParams.get('sample_rate') ?? 16000);
        let bytes = 0,
            messages = 0,
            done = false,
            waited: number | undefined,
            number = 0;
        const opened = performance.now();
        const said = (): string => lines[number - 1] ?? `Utterance ${number}.`;
        const results = (final: boolean): void => {
            const words = said().split(' '),
                text = final ? said() : words.slice(0, Math.min(words.length, messages)).join(' ');
            const result = {
                type: 'Results',
                is_final: final,
                speech_final: final,
                start: 0,
                duration: bytes / 2 / rate,
                channel: { alternatives: [{ transcript: text, confidence: 0.99 }] },
            };
            socket.write(frame(1, Buffer.from(JSON.stringify(result))));
        };
        const finish = (closed: boolean, dropped = false): void => {
            if (done) return;
            done = true;
            record(
                log,
                'deepgram-live',
                JSON.stringify({
                    ...queryOf(url),
                    key,
                    seconds: bytes / 2 / rate,
                    messages,
                    closed,
                    waited,
                    dropped,
                } satisfies DeepgramRequest),
            );
        };
        frames(socket, head, (opcode, payload) => {
            if (opcode === 2) {
                if (waited === undefined) {
                    waited = (performance.now() - opened) / 1000;
                    number = ++streams;
                    if (number === Number(environment['FAKE_DEEPGRAM_DROP'] ?? 0)) {
                        finish(false, true);
                        socket.destroy();
                        return;
                    }
                }
                bytes += payload.length;
                messages++;
                results(false);
            } else if (opcode === 1 && /"CloseStream"/.test(payload.toString('utf8'))) {
                results(true);
                socket.write(frame(1, Buffer.from(JSON.stringify({ type: 'Metadata', duration: bytes / 2 / rate, channels: 1 }))));
                socket.write(frame(8, Buffer.from([0x03, 0xe8])));
                finish(true);
                socket.end();
            } else if (opcode === 8) {
                finish(false);
                socket.end(frame(8, Buffer.from([0x03, 0xe8])));
            } else if (opcode === 9) {
                socket.write(frame(10, payload));
            }
        });
        socket.on('close', () => finish(false));
        socket.on('error', () => finish(false));
    }

    const server = createServer((request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const handled =
            request.method === 'POST' && url.pathname === '/v1/messages'
                ? anthropic(request, response)
                : request.method === 'POST' && url.pathname === '/v1/listen'
                  ? deepgramFile(request, response, url)
                  : request.method === 'GET' && url.pathname === '/v1/projects'
                    ? Promise.resolve(
                          deepgramKey(request) === FAKE_KEYS.deepgram
                              ? json(response, 200, { projects: [] })
                              : json(response, 401, { err_code: 'INVALID_AUTH', err_msg: 'Invalid credentials.' }),
                      )
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
