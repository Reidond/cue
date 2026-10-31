import { type CallCommand, CallCommand as CallCommandSchema, type CallEvent, type Channel } from '@cue/contract';
import { Value } from '@sinclair/typebox/value';
import { DurableObject, env } from 'cloudflare:workers';
import { preparedIn } from '../materials/read.ts';
import { termsOf } from '../projects.ts';
import { recordUsage } from '../usage.ts';
import { describe } from './anthropic.ts';
import { QuestionDetector } from './detector.ts';
import { SpeechStream } from './deepgram.ts';
import { QuestionJudge } from './judge.ts';
import { answerPrompt, firstSentence, isEcho, judgePrompt, Matcher, type PreparedAnswer } from './knowledge.ts';
import { lexiconFor, type CallLexicon } from './lexicon.ts';
import { ANSWER_MODEL, noTokens, SPEECH_MICROS_PER_SECOND, SPEECH_MODEL, type Tokens, tokenUsage, type UsageRow } from './models.ts';
import { ClaudeSession, type SessionState } from './session.ts';

// One Call per call id: everything a live call needs on the server. It holds a Deepgram live stream per channel, spots questions on each
// final line (the judge, the waiting rules), matches prepared answers, answers with Claude, keeps the prompt cache warm while the call is
// quiet, and tells the connected client (a WebSocket the Worker hands over, see routes/calls.ts) what happens, in the events of
// packages/contract. A client that drops and reconnects to the same call resumes it: the events it missed are sent again.
//
// Called through RPC (`begin`, `ask`, `end`); `fetch` exists only for the WebSocket upgrade.

export interface Meta {
    callId: string;
    userId: string;
    projectId: string;
    startedAt: number;
    speaker: string;
    auto: boolean;
    micQuestions: boolean;
    questions: boolean;
    ended: boolean;
}

type Draft = CallEvent extends infer Event ? (Event extends { seq: number } ? Omit<Event, 'seq'> : never) : never;

interface Line {
    channel: Channel;
    text: string;
    speaker: number | null;
    start: number;
    end: number;
    /** Wall clock, milliseconds. */
    started: number;
    ended: number;
}

interface Question {
    id: string;
    text: string;
    requested: boolean;
    askedAt: number;
}

interface Exchange {
    id: string;
    forced: boolean;
    questions: Question[];
    /** Sees every event of the exchange (the HTTP answer of `POST …/questions`). */
    tap?: (event: CallEvent) => void;
}

const EVENT_LOG = 1000;
const seconds = (name: keyof Env, fallback: number) => {
    const value = Number(env[name]);
    return Number.isFinite(value) && value > 0 ? value * 1000 : fallback * 1000;
};

export class Call extends DurableObject<Env> {
    #meta: Meta | undefined;
    #ready: Promise<void> | undefined;

    // What the call knows, built from the project when it begins.
    #language = 'en';
    #terms: string[] = [];
    #occasion = '';
    #texts: string[] = [];
    #lexicon: CallLexicon = lexiconFor('en');
    #matcher = new Matcher([], new Set());
    #answers: ClaudeSession | undefined;
    #judge: QuestionJudge | undefined;
    #detector = new QuestionDetector();
    #streams: Partial<Record<Channel, SpeechStream>> = {};
    #speechOk: Partial<Record<Channel, boolean>> = {};
    #speechDetail: Partial<Record<Channel, string>> = {};
    #abort = new AbortController();

    // What happened.
    #seq = 0;
    #log: CallEvent[] = [];
    #statuses = new Map<string, CallEvent>();
    #sockets = new Set<WebSocket>();
    #lastClientAt = Date.now();
    #everConnected = false;
    #lines: Line[] = [];
    #exchanges = new Map<string, Exchange>();
    #byQuestion = new Map<string, Exchange>();
    #partial: Partial<Record<Channel, string>> = {};
    #speaking: Record<Channel, boolean> = { me: false, others: false };
    #tokens = new Map<string, Tokens>();
    #billedSeconds: Partial<Record<Channel, number>> = {};

    // MARK: RPC

    /** Starts the call: reads the project, builds Claude's prompt, warms the caches. */
    async begin(meta: Omit<Meta, 'ended'>): Promise<void> {
        this.#meta = { ...meta, ended: false };
        await this.ctx.storage.put('meta', this.#meta);
        this.#ready = this.#init();
        await this.#ready;
        await this.ctx.storage.setAlarm(Date.now() + seconds('CACHE_TICK_SECONDS', 300));
    }

    /** The Ask field: answers `text` as an exchange of its own, as server-sent events (the same events the socket gets, for this exchange). */
    async ask(text: string): Promise<ReadableStream<Uint8Array>> {
        await this.#ensure();
        const encoder = new TextEncoder();
        let finish: (() => void) | undefined;
        return new ReadableStream<Uint8Array>({
            start: (controller) => {
                const pending = new Set<string>();
                const tap = (event: CallEvent) => {
                    if (event.type === 'question') pending.add(event.id);
                    controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
                    if (event.type === 'answer.done') {
                        pending.delete(event.questionId);
                        if (pending.size === 0) finish?.();
                    }
                };
                finish = () => {
                    try {
                        controller.close();
                    } catch {
                        /* closed */
                    }
                };
                this.#ask([text], { force: true, request: true, tap });
            },
            cancel: () => {
                finish = undefined;
            },
        });
    }

    /** Ends the call: the speech streams finish, usage is recorded, the transcript is kept. */
    async end(): Promise<{ lines: number }> {
        await this.#ensure();
        await this.#finish();
        return { lines: this.#lines.length };
    }

    // MARK: The live socket

    /** The WebSocket upgrade, handed over by the Worker. */
    override async fetch(request: Request): Promise<Response> {
        await this.#ensure();
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
            return new Response('Expected a WebSocket upgrade', { status: 426 });
        const after = Number(new URL(request.url).searchParams.get('after'));
        const { 0: client, 1: server } = new WebSocketPair();
        server.accept();
        server.binaryType = 'arraybuffer';
        server.addEventListener('message', (event) => this.#message(event.data));
        server.addEventListener('close', () => this.#disconnected(server));
        server.addEventListener('error', () => this.#disconnected(server));
        this.#connected(server, Number.isFinite(after) && after > 0 ? after : undefined);
        return new Response(null, { status: 101, webSocket: client });
    }

    #connected(socket: WebSocket, after: number | undefined): void {
        const meta = this.#meta;
        if (!meta) return socket.close(1011, 'unknown call');
        const resumed = after !== undefined || this.#everConnected;
        this.#everConnected = true;
        this.#sockets.add(socket);
        this.#lastClientAt = Date.now();
        const ready: CallEvent = { type: 'ready', seq: this.#seq, callId: meta.callId, resumed, startedAt: meta.startedAt };
        socket.send(JSON.stringify(ready));
        if (after === undefined) {
            for (const status of this.#statuses.values()) socket.send(JSON.stringify(status));
        } else {
            for (const event of this.#log) if (event.seq > after) socket.send(JSON.stringify(event));
        }
        if (meta.ended) {
            socket.close(1000, 'ended');
            return;
        }
        // Speech recognition is opened when the first client is there, so it is ready before the first word.
        void this.#openSpeech();
    }

    #disconnected(socket: WebSocket): void {
        if (!this.#sockets.delete(socket)) return;
        this.#lastClientAt = Date.now();
        try {
            socket.close(1000, 'bye');
        } catch {
            /* already closed */
        }
    }

    #message(data: string | ArrayBuffer): void {
        void this.#ensure().then(() => {
            if (this.#meta?.ended) return;
            if (typeof data !== 'string') return this.#audio(data);
            let command: unknown;
            try {
                command = JSON.parse(data);
            } catch {
                return;
            }
            if (Value.Check(CallCommandSchema, command)) this.#command(command);
        });
    }

    /** Audio: one byte for the channel, then PCM. */
    #audio(frame: ArrayBuffer): void {
        if (frame.byteLength < 3) return;
        const channel: Channel = new Uint8Array(frame, 0, 1)[0] === 0 ? 'me' : 'others';
        this.#streams[channel]?.send(frame.slice(1));
    }

    #command(command: CallCommand): void {
        const meta = this.#meta;
        if (!meta) return;
        switch (command.type) {
            case 'config': {
                const wasAsking = meta.questions;
                if (command.speaker !== undefined && command.speaker !== meta.speaker) {
                    meta.speaker = command.speaker;
                    this.#restartPrompts();
                }
                meta.auto = command.auto ?? meta.auto;
                meta.micQuestions = command.micQuestions ?? meta.micQuestions;
                meta.questions = command.questions ?? meta.questions;
                if (wasAsking && !meta.questions) this.#detector.take();
                void this.ctx.storage.put('meta', meta);
                break;
            }
            case 'ask':
                this.#ask([command.text], { force: true, request: true });
                break;
            case 'answerNow':
                this.#answerNow();
                break;
            case 'prepare': {
                const exchange = this.#exchanges.get(command.exchange);
                if (exchange) this.#send(exchange);
                break;
            }
        }
    }

    // MARK: Events

    #emit(draft: Draft): CallEvent {
        const event = { ...draft, seq: ++this.#seq } as CallEvent;
        // A partial is replaced by the next one (and by the final): a client that was away has no use for the old ones.
        if (event.type !== 'transcript.partial') this.#log.push(event);
        if (this.#log.length > EVENT_LOG) this.#log.splice(0, this.#log.length - EVENT_LOG);
        if (event.type === 'status') this.#statuses.set(event.part, event);
        const text = JSON.stringify(event);
        for (const socket of this.#sockets) {
            try {
                socket.send(text);
            } catch {
                this.#sockets.delete(socket);
            }
        }
        return event;
    }

    /** An event of an exchange: also to whoever asked for it over HTTP. */
    #emitFor(exchange: Exchange, draft: Draft): void {
        const event = this.#emit(draft);
        exchange.tap?.(event);
    }

    #status(part: 'speech' | 'claude' | 'judge', state: SessionState, detail: string): void {
        const last = this.#statuses.get(part);
        if (last?.type === 'status' && last.state === state && last.detail === detail) return;
        this.#emit({ type: 'status', part, state, detail });
    }

    // MARK: Starting up

    async #ensure(): Promise<void> {
        if (this.#ready) return this.#ready;
        this.#ready = (async () => {
            this.#meta ??= await this.ctx.storage.get<Meta>('meta');
            if (!this.#meta) return;
            // A call whose Durable Object was evicted and comes back: the project is read again, the conversation restored.
            if (!this.#meta.ended) await this.#init();
        })();
        return this.#ready;
    }

    async #init(): Promise<void> {
        const meta = this.#meta!;
        const project = await env.DB.prepare('SELECT name, occasion, language, names_and_terms FROM project WHERE id = ? AND user_id = ?')
            .bind(meta.projectId, meta.userId)
            .first<{ name: string; occasion: string; language: string; names_and_terms: string }>();
        this.#language = project?.language ?? 'en';
        this.#lexicon = lexiconFor(this.#language);
        const { results } = await env.DB.prepare(
            'SELECT name, text, qa FROM material WHERE project_id = ? AND user_id = ? AND error IS NULL ORDER BY created_at, id',
        )
            .bind(meta.projectId, meta.userId)
            .all<{ name: string; text: string; qa: string | null }>();
        const prepared: PreparedAnswer[] = results.flatMap((material) => preparedIn(material, this.#language));
        this.#matcher = new Matcher(prepared, this.#lexicon.stopWords);
        this.#terms = termsOf(project?.names_and_terms ?? '');
        this.#occasion = project?.occasion ?? '';
        this.#texts = results.map((material) => material.text);
        const history = (await this.ctx.storage.get<{ role: 'user' | 'assistant'; content: string }[]>('history')) ?? [];
        this.#startPrompts(history);
        this.#detector.judge = (speech) => this.#judgeSpeech(speech);
        this.#detector.onQuestions = (questions) => this.#ask(questions, { force: false, request: this.#meta?.auto ?? true });
    }

    #startPrompts(history: { role: 'user' | 'assistant'; content: string }[]): void {
        const meta = this.#meta!;
        const who = { speaker: meta.speaker, occasion: this.#occasion };
        this.#answers?.stop();
        this.#judge?.stop();
        this.#answers = new ClaudeSession(
            {
                model: ANSWER_MODEL,
                system: answerPrompt(who, this.#lexicon, this.#matcher.prepared, this.#texts),
                title: 'Claude Sonnet',
                mode: 'stream',
                maxTokens: 4096,
                onState: (state, detail) => this.#status('claude', state, detail),
                onTokens: (model, _kind, tokens) => this.#count('answer', model, tokens),
            },
            history,
        );
        this.#judge = new QuestionJudge(judgePrompt(who, this.#lexicon), {
            onState: (state, detail) => this.#status('judge', state, detail),
            onTokens: (model, _kind, tokens) => this.#count('question_judge', model, tokens),
        });
        this.#answers.start();
        this.#judge.start();
    }

    /** The speaker's name changed: Claude's prompts name them, so both sessions start again. */
    #restartPrompts(): void {
        this.#startPrompts([...(this.#answers?.history ?? [])]);
    }

    // MARK: Speech

    async #openSpeech(): Promise<void> {
        const meta = this.#meta;
        if (!meta || meta.ended) return;
        if ((['me', 'others'] as const).every((channel) => this.#streams[channel])) return;
        this.#status('speech', 'starting', 'Starting speech recognition…');
        const clock = () => (Date.now() - meta.startedAt) / 1000;
        for (const channel of ['me', 'others'] as const) {
            if (this.#streams[channel]) continue;
            const stream = new SpeechStream(
                channel,
                { language: this.#language, terms: this.#terms, diarize: channel === 'others' },
                {
                    onSpeaking: (active) => this.#speak(channel, active),
                    onPartial: (text, speaker, start, end) => this.#partialLine(channel, text, speaker, start, end),
                    onFinal: (text, speaker, start, end) => this.#finalLine(channel, text, speaker, start, end),
                    onState: (ok, detail) => {
                        this.#speechOk[channel] = ok;
                        this.#speechDetail[channel] = detail;
                        this.#speechStatus();
                    },
                },
                clock,
            );
            this.#streams[channel] = stream;
            void stream.open();
        }
    }

    #speechStatus(): void {
        const problem = (['me', 'others'] as const).find((channel) => this.#speechOk[channel] === false);
        if (problem) return this.#status('speech', 'unavailable', this.#speechDetail[problem] ?? 'Speech recognition is unavailable.');
        if ((['me', 'others'] as const).every((channel) => this.#speechOk[channel] === true))
            this.#status('speech', 'ready', 'Speech recognition ready');
    }

    #speak(channel: Channel, active: boolean): void {
        if (this.#speaking[channel] === active) return;
        this.#speaking[channel] = active;
        this.#emit({ type: 'speaking', channel, active });
        if (!active || !this.#meta?.questions) return;
        this.#partial[channel] = '';
        if (channel === 'others') {
            this.#detector.participantsSpeaking();
        } else if (!this.#speaking.others) {
            // With speakers instead of headphones the microphone also hears the call; do not mistake that for the user.
            this.#detector.presenterSpeaking();
        }
    }

    #partialLine(channel: Channel, text: string, speaker: number | null, start: number, end: number): void {
        this.#partial[channel] = text;
        this.#emit({ type: 'transcript.partial', channel, speaker, text, start, end });
    }

    #finalLine(channel: Channel, text: string, speaker: number | null, start: number, end: number): void {
        const meta = this.#meta;
        if (!meta) return;
        this.#partial[channel] = '';
        const ended = meta.startedAt + end * 1000;
        const started = meta.startedAt + start * 1000;
        if (text === '' || this.#isEcho(channel, text)) {
            if (channel === 'others') this.#detector.participantsStopped(ended);
            return;
        }
        const line: Line = { channel, text, speaker, start, end, started, ended };
        this.#lines.push(line);
        if (this.#lines.length > 3000) this.#lines.splice(0, this.#lines.length - 3000);
        this.#emit({ type: 'transcript.final', channel, speaker, text, start, end });
        void this.ctx.storage.put('lines', this.#lines);
        // Questions are only looked for while the client asks for them (Cue running: the overlay shows them).
        if (meta.questions && (channel === 'others' || meta.micQuestions))
            this.#detector.add(text, this.#judgeLabel(channel), started, ended);
    }

    /** The microphone picking up the call through speakers produces a near-copy of a participant line. */
    #isEcho(channel: Channel, text: string): boolean {
        if (channel !== 'me') return false;
        const now = Date.now();
        return this.#lines
            .slice(-4)
            .some((other) => other.channel === 'others' && now - other.ended < 15_000 && isEcho(text, other.text, this.#lexicon.stopWords));
    }

    // MARK: Questions

    #promptLabel(channel: Channel): string {
        const speaker = this.#meta?.speaker.trim() ?? '';
        return channel === 'me' ? (speaker === '' ? 'Speaker' : speaker) : 'Participant';
    }

    /** Who said a line, for the judge. Listening for questions from the room, the microphone hears the people around the speaker too, so it cannot be labelled as the speaker. */
    #judgeLabel(channel: Channel): string {
        return channel === 'me' && this.#meta?.micQuestions ? 'Room' : this.#promptLabel(channel);
    }

    /** What the judge reads: the last two minutes for context, then what was just said. */
    async #judgeSpeech(speech: string): Promise<string[] | null> {
        const said = new Set(this.#detector.buffer.map((line) => line.started));
        const now = Date.now();
        const context = this.#lines
            .filter((line) => now - line.ended < 120_000 && !said.has(line.started))
            .slice(-10)
            .map((line) => `[${this.#judgeLabel(line.channel)}] ${line.text}`)
            .join('\n');
        const message = `${context === '' ? '' : `Said earlier (context):\n${context.slice(-2000)}\n\n`}Just said:\n${speech}`;
        return (await this.#judge?.judge(message)) ?? null;
    }

    #answerNow(): void {
        const taken = this.#detector.take();
        const live = this.#partial.others ?? '';
        let speech = taken?.speech ?? '';
        if (live !== '') speech += (speech === '' ? '' : ' ') + live;
        if (speech === '') speech = this.#lines.findLast((line) => line.channel === 'others')?.text ?? this.#lines.at(-1)?.text ?? '';
        if (speech === '') return;
        // The judge has not heard what is still being said.
        const questions = live === '' ? (taken?.questions ?? []) : [];
        this.#ask(questions.length === 0 ? [speech] : questions, { force: true, request: true });
    }

    /**
     * Questions asked in one go, answered each on its own and listed together. `force` when the person asked for it: shown at once. Without
     * `request` they are only listed, for `prepare`.
     */
    #ask(texts: string[], options: { force: boolean; request: boolean; tap?: (event: CallEvent) => void }): void {
        if (!this.#answers || this.#meta?.ended) return;
        const exchange: Exchange = {
            id: crypto.randomUUID(),
            forced: options.force,
            questions: texts.map((text) => ({ id: crypto.randomUUID(), text, requested: false, askedAt: Date.now() })),
            tap: options.tap,
        };
        this.#exchanges.set(exchange.id, exchange);
        exchange.questions.forEach((question, index) => {
            this.#byQuestion.set(question.id, exchange);
            const match = this.#matcher.match(question.text);
            const opener =
                (match && firstSentence(match.answer.a, this.#lexicon.thanksPrefix)) ??
                (this.#lexicon.defaultOpener === '' ? null : this.#lexicon.defaultOpener);
            this.#emitFor(exchange, {
                type: 'question',
                id: question.id,
                exchange: exchange.id,
                index,
                of: exchange.questions.length,
                text: question.text,
                opener,
                requested: options.request,
                forced: options.force,
            });
            if (match) {
                this.#emitFor(exchange, {
                    type: 'prepared',
                    questionId: question.id,
                    question: match.answer.q,
                    answer: match.answer.a,
                    who: match.answer.who,
                    source: match.answer.source,
                    score: match.score,
                });
            }
        });
        if (options.request) this.#send(exchange);
    }

    /** Sends an exchange's questions that are still waiting to Claude, each as its own request. */
    #send(exchange: Exchange): void {
        const answers = this.#answers;
        if (!answers) return;
        const all = exchange.questions;
        for (const question of all) {
            if (question.requested) continue;
            question.requested = true;
            question.askedAt = Date.now();
            const others = all.filter((other) => other !== question).map((other) => `«${other.text}»`);
            const message = this.#messageFor(question.text, others, exchange.forced);
            answers
                .ask(
                    message,
                    (piece) => this.#emitFor(exchange, { type: 'answer.delta', questionId: question.id, text: piece }),
                    this.#abort.signal,
                )
                .then(
                    () => {
                        void this.ctx.storage.put('history', [...answers.history]);
                        this.#emitFor(exchange, { type: 'answer.done', questionId: question.id, error: null });
                    },
                    (error: unknown) => this.#emitFor(exchange, { type: 'answer.done', questionId: question.id, error: describe(error) }),
                );
        }
    }

    #messageFor(question: string, others: string[], force: boolean): string {
        const now = Date.now();
        const context = this.#lines
            .filter((line) => now - line.ended < 180_000 && !question.includes(line.text))
            .slice(-12)
            .map((line) => `[${this.#promptLabel(line.channel)}] ${line.text}`)
            .join('\n');
        let message = context === '' ? '' : `Recent transcript (context):\n${context.slice(-2500)}\n\n`;
        message += `Question: [${this.#promptLabel('others')}] ${question}`;
        if (others.length > 0) {
            message += `\n\n(Asked in one go with ${others.join(', ')}, which are answered separately: answer only this question.)`;
        }
        message += force
            ? '\n\n(The speaker asked for an answer themselves — even if this is not a question, suggest what to say.)'
            : '\n\n(Noticed automatically. If it is not a question or remark addressed to the speaker, reply with — alone.)';
        return message;
    }

    // MARK: Usage

    #count(feature: string, model: string, tokens: Tokens): void {
        const key = `${feature}\u0000${model}`;
        const total = this.#tokens.get(key) ?? noTokens();
        total.input += tokens.input;
        total.output += tokens.output;
        total.cacheWrite += tokens.cacheWrite;
        total.cacheRead += tokens.cacheRead;
        this.#tokens.set(key, total);
    }

    /** Writes what the call used since the last time to the `usage` table: tokens per model, audio seconds. */
    async #flushUsage(): Promise<void> {
        const meta = this.#meta;
        if (!meta) return;
        const rows: UsageRow[] = [];
        for (const [key, tokens] of this.#tokens) {
            const [feature, model] = key.split('\u0000') as [string, string];
            rows.push(...tokenUsage(feature, model, tokens));
        }
        this.#tokens.clear();
        for (const channel of ['me', 'others'] as const) {
            const total = this.#streams[channel]?.seconds ?? 0;
            const delta = total - (this.#billedSeconds[channel] ?? 0);
            this.#billedSeconds[channel] = total;
            if (delta > 0)
                rows.push([
                    'live_transcript',
                    'deepgram',
                    SPEECH_MODEL,
                    Math.round(delta * 1000) / 1000,
                    'audio_seconds',
                    Math.round(delta * SPEECH_MICROS_PER_SECOND),
                ]);
        }
        await recordUsage(env.DB, meta.userId, rows);
    }

    // MARK: Time

    /** Keeps the prompt caches warm while the call is quiet, ends a call nobody is connected to any more, and records usage. */
    override async alarm(): Promise<void> {
        await this.#ensure();
        const meta = this.#meta;
        if (!meta || meta.ended) return;
        const refresh = seconds('CACHE_REFRESH_SECONDS', 2700);
        this.#answers?.keepWarm(refresh);
        this.#judge?.keepWarm(refresh);
        await this.#flushUsage().catch((error: unknown) => console.error('usage', error));
        if (this.#sockets.size === 0 && Date.now() - this.#lastClientAt > seconds('CALL_GRACE_SECONDS', 120)) {
            await this.#finish();
            return;
        }
        await this.ctx.storage.setAlarm(Date.now() + seconds('CACHE_TICK_SECONDS', 300));
    }

    async #finish(): Promise<void> {
        const meta = this.#meta;
        if (!meta || meta.ended) return;
        meta.ended = true;
        this.#detector.stop();
        this.#abort.abort();
        await Promise.all(Object.values(this.#streams).map((stream) => stream.close()));
        this.#answers?.stop();
        this.#judge?.stop();
        await this.#flushUsage().catch((error: unknown) => console.error('usage', error));
        const endedAt = Date.now();
        await env.DB.prepare('UPDATE call SET ended_at = ?, transcript = ? WHERE id = ?')
            .bind(
                endedAt,
                JSON.stringify(this.#lines.map(({ channel, speaker, text, start, end }) => ({ channel, speaker, text, start, end }))),
                meta.callId,
            )
            .run();
        this.#emit({ type: 'ended', lines: this.#lines.length });
        for (const socket of this.#sockets) {
            try {
                socket.close(1000, 'ended');
            } catch {
                /* closed */
            }
        }
        this.#sockets.clear();
        await this.ctx.storage.put('meta', meta);
        await this.ctx.storage.deleteAlarm();
    }
}
