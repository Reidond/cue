import { env } from 'cloudflare:workers';
import { ANTHROPIC_VERSION, noTokens, type Tokens } from './models.ts';

// The Anthropic Messages API (ANTHROPIC_URL), with the owner's key. Nothing of the user's token ever goes here.

export class AnthropicFailure extends Error {
    readonly status: number;
    readonly type: string;

    constructor(status: number, type: string, message: string) {
        super(message);
        this.status = status;
        this.type = type;
    }

    /** Worth another try: rate limits, overload, server errors. */
    get transient() {
        return this.status === 429 || this.status >= 500 || this.type === 'overloaded_error';
    }
}

/** A streamed reply that ended without `message_stop`: the connection closed partway. */
export class BrokenOff extends Error {
    constructor() {
        super("Claude's reply broke off before the end");
    }
}

/** Failures worth trying again in a moment. */
export const transient = (error: unknown) =>
    (error instanceof AnthropicFailure && error.transient) || error instanceof BrokenOff || error instanceof TypeError;

/** What a failure means for the person; never the provider's own words about keys or accounts. */
export function describe(error: unknown): string {
    if (error instanceof AnthropicFailure) {
        if (error.status === 401 || error.status === 403)
            return 'Cue could not reach Claude (the plan’s key was refused). The owner has been told.';
        if (error.status === 429) return 'Claude is busy right now (rate limit). Try again in a moment.';
        if (error.status === 529) return 'Claude is overloaded. Try again in a moment.';
        return error.message ? `Claude: ${error.message}` : `Claude: error ${error.status}`;
    }
    if (error instanceof BrokenOff) return error.message;
    return 'Cue could not reach Claude.';
}

function request(body: object, signal?: AbortSignal): Promise<Response> {
    return fetch(`${env.ANTHROPIC_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
    });
}

async function failure(response: Response): Promise<AnthropicFailure> {
    const text = await response.text();
    let error: { type?: string; message?: string } | undefined;
    try {
        error = (JSON.parse(text) as { error?: { type?: string; message?: string } }).error;
    } catch {
        /* not JSON */
    }
    return new AnthropicFailure(response.status, error?.type ?? '', error?.message ?? text.slice(0, 200));
}

interface RawUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}

function addUsage(into: Tokens, usage: RawUsage | undefined): void {
    if (!usage) return;
    // A later event repeats the earlier counts it knows: take the larger.
    into.input = Math.max(into.input, usage.input_tokens ?? 0);
    into.output = Math.max(into.output, usage.output_tokens ?? 0);
    into.cacheWrite = Math.max(into.cacheWrite, usage.cache_creation_input_tokens ?? 0);
    into.cacheRead = Math.max(into.cacheRead, usage.cache_read_input_tokens ?? 0);
}

const sleep = (seconds: number) => new Promise((resolve) => setTimeout(resolve, seconds * 1000));

/** Sends a request and waits for the whole reply (no streaming). What is transient is tried twice more. */
export async function send(body: object): Promise<{ text: string; tokens: Tokens }> {
    for (let attempt = 0; ; attempt++) {
        try {
            const response = await request({ ...body, stream: false });
            if (!response.ok) throw await failure(response);
            const reply = (await response.json()) as { content?: { type: string; text?: string }[]; usage?: RawUsage };
            const tokens = noTokens();
            addUsage(tokens, reply.usage);
            return { text: (reply.content ?? []).map((block) => block.text ?? '').join(''), tokens };
        } catch (error) {
            if (!transient(error) || attempt >= 2) throw error;
            await sleep(attempt + 1);
        }
    }
}

/**
 * Streams a reply's text through `onText`, piece by piece, and returns all of it, only once `message_stop` says it's whole. Rate limits,
 * overload and dropped connections are tried twice more, unless some of the reply has come already.
 */
export async function stream(
    body: object,
    onText: (piece: string) => void,
    signal?: AbortSignal,
): Promise<{ text: string; tokens: Tokens }> {
    for (let attempt = 0; ; attempt++) {
        let text = '';
        const tokens = noTokens();
        try {
            const response = await request({ ...body, stream: true }, signal);
            if (!response.ok || !response.body) throw await failure(response);
            let finished = false;
            let stopReason: string | undefined;
            const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
            let buffer = '';
            read: for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += value;
                for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
                    const line = buffer.slice(0, newline).trimEnd();
                    buffer = buffer.slice(newline + 1);
                    if (!line.startsWith('data:')) continue;
                    let event: {
                        type?: string;
                        delta?: { type?: string; text?: string; stop_reason?: string };
                        message?: { usage?: RawUsage };
                        usage?: RawUsage;
                        error?: { type?: string; message?: string };
                    };
                    try {
                        event = JSON.parse(line.slice(5));
                    } catch {
                        continue;
                    }
                    switch (event.type) {
                        case 'message_start':
                            addUsage(tokens, event.message?.usage);
                            break;
                        case 'content_block_delta':
                            if (event.delta?.type === 'text_delta' && event.delta.text) {
                                text += event.delta.text;
                                onText(event.delta.text);
                            }
                            break;
                        case 'message_delta':
                            stopReason = event.delta?.stop_reason ?? stopReason;
                            addUsage(tokens, event.usage);
                            break;
                        case 'error':
                            throw new AnthropicFailure(
                                event.error?.type === 'overloaded_error' ? 529 : 500,
                                event.error?.type ?? '',
                                event.error?.message ?? '',
                            );
                        case 'message_stop':
                            finished = true;
                            break read;
                    }
                }
            }
            if (!finished) throw new BrokenOff();
            if (stopReason === 'refusal' && text === '') throw new Error('Claude declined to answer this');
            return { text, tokens };
        } catch (error) {
            if (signal?.aborted || !transient(error) || text !== '' || attempt >= 2) {
                // What was paid for before it broke still counts.
                (error as { tokens?: Tokens }).tokens = tokens;
                throw error;
            }
            await sleep(attempt + 1);
        }
    }
}
