import { describe, send, stream, transient } from './anthropic.ts';
import { noThinking, type Tokens } from './models.ts';

// A conversation with Claude that answers one message after another: each message goes with the conversation so far, and the system prompt
// (the materials) is cached for an hour, written before the first message and kept warm while the room is quiet, so an answer starts quickly.
// The port of the Mac app's `ClaudeAPIService`, now over the owner's key.

export type SessionState = 'starting' | 'ready' | 'unavailable';

export interface SessionOptions {
    model: string;
    system: string;
    /** How the person's status line names it while it warms up: "Claude Sonnet". */
    title: string;
    /** `stream` for answers (the text comes piece by piece), `send` for short verdicts. */
    mode: 'stream' | 'send';
    maxTokens: number;
    /** Keeps only the latest messages of the conversation (a judge needs no long memory). */
    maxMessages?: number;
    onState: (state: SessionState, detail: string) => void;
    /** Tokens of every request, whether it worked or not. */
    onTokens: (model: string, kind: 'warm' | 'message', tokens: Tokens) => void;
}

type Message = { role: 'user' | 'assistant'; content: string };

const CACHE = { type: 'ephemeral', ttl: '1h' } as const;

export class ClaudeSession {
    readonly #options: SessionOptions;
    #history: Message[] = [];
    #inFlight = 0;
    #lastActivity = Date.now();
    #stopped = false;
    #retry: ReturnType<typeof setTimeout> | undefined;
    state: SessionState = 'starting';

    constructor(options: SessionOptions, history: Message[] = []) {
        this.#options = options;
        this.#history = history;
    }

    get history(): readonly Message[] {
        return this.#history;
    }

    /** Writes the system prompt into the cache (the first warm-up says whether the session is ready). One that failed for a passing reason is tried again every 15 s. */
    start(): void {
        this.#set('starting', `Warming up ${this.#options.title}…`);
        void this.#warmUp();
    }

    stop(): void {
        this.#stopped = true;
        clearTimeout(this.#retry);
    }

    /** Warms the cache again when the session has been quiet for `idleMs` and nothing is under way. */
    keepWarm(idleMs: number): void {
        if (this.#stopped || this.state !== 'ready' || this.#inFlight > 0 || Date.now() - this.#lastActivity < idleMs) return;
        void this.#warm().catch(() => {});
    }

    async #warmUp(): Promise<void> {
        try {
            await this.#warm();
            this.#set('ready', `${this.#options.title} ready`);
        } catch (error) {
            if (this.#stopped) return;
            this.#set('unavailable', describe(error));
            if (transient(error)) this.#retry = setTimeout(() => void this.#warmUp(), 15_000);
        }
    }

    /** Writes the system prompt into the cache without an answer (`max_tokens: 0`), with the settings the messages have so that they read it. */
    async #warm(): Promise<void> {
        this.#lastActivity = Date.now();
        this.#inFlight++;
        try {
            const result = await send(this.#request([{ role: 'user', content: 'Connection check before the talk.' }], 0, true));
            this.#options.onTokens(this.#options.model, 'warm', result.tokens);
        } finally {
            this.#inFlight--;
            this.#lastActivity = Date.now();
        }
    }

    /**
     * Sends `text` with the conversation so far and returns the whole reply, `onText` getting the pieces of a streamed one. A reply that
     * came back whole joins the conversation.
     */
    async ask(text: string, onText: (piece: string) => void = () => {}, signal?: AbortSignal): Promise<string> {
        this.#lastActivity = Date.now();
        this.#inFlight++;
        const question: Message = { role: 'user', content: text };
        const body = this.#request([...this.#history, question], this.#options.maxTokens, false);
        try {
            const result = this.#options.mode === 'stream' ? await stream(body, onText, signal) : await send(body);
            this.#options.onTokens(this.#options.model, 'message', result.tokens);
            if (result.text !== '') {
                this.#history.push(question, { role: 'assistant', content: result.text });
                const max = this.#options.maxMessages;
                if (max !== undefined && this.#history.length > max) this.#history.splice(0, this.#history.length - max);
            }
            return result.text;
        } catch (error) {
            const tokens = (error as { tokens?: Tokens }).tokens;
            if (tokens) this.#options.onTokens(this.#options.model, 'message', tokens);
            throw error;
        } finally {
            this.#inFlight--;
            this.#lastActivity = Date.now();
        }
    }

    /** The system prompt has its own hour-long cache entry; a message also caches the conversation up to it (top-level `cache_control`), which the warm-up leaves out. */
    #request(messages: Message[], maxTokens: number, warmup: boolean): object {
        const { model, system } = this.#options;
        return {
            model,
            max_tokens: maxTokens,
            thinking: noThinking(model),
            messages,
            ...(system === '' ? {} : { system: [{ type: 'text', text: system, cache_control: CACHE }] }),
            ...(warmup ? {} : { cache_control: CACHE }),
        };
    }

    #set(state: SessionState, detail: string): void {
        this.state = state;
        if (!this.#stopped) this.#options.onState(state, detail);
    }
}
