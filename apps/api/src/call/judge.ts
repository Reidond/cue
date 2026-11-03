import { JUDGE_MODEL } from './models.ts';
import { ClaudeSession, type SessionOptions } from './session.ts';

// A second, small Claude session (Haiku, without the materials) that reads what the participants just said and tells which questions in it
// are for the speaker, so only those get an answer. judge.md is its prompt. The port of the Mac app's `QuestionJudge`.

/** A verdict slower than this is no use: the question would have been answered already. */
const PATIENCE_MS = 6000;

export class QuestionJudge {
    readonly #session: ClaudeSession;

    constructor(system: string, options: Pick<SessionOptions, 'onState' | 'onTokens'>) {
        this.#session = new ClaudeSession({
            ...options,
            model: JUDGE_MODEL,
            system,
            title: 'Claude Haiku',
            mode: 'send',
            maxTokens: 1024,
            maxMessages: 40,
        });
    }

    get state() {
        return this.#session.state;
    }

    start(): void {
        this.#session.start();
    }

    stop(): void {
        this.#session.stop();
    }

    keepWarm(idleMs: number): void {
        this.#session.keepWarm(idleMs);
    }

    /** The questions in `message` for the speaker (none: []), or null when the judge could not tell (not ready, failed, too slow). */
    async judge(message: string): Promise<Judged[] | null> {
        if (this.#session.state !== 'ready') return null;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const patience = new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), PATIENCE_MS);
        });
        try {
            const reply = this.#session.ask(message).then(questionsIn, () => null);
            return await Promise.race([reply, patience]);
        } finally {
            clearTimeout(timer);
        }
    }
}

/** A question the judge found, and its translation when it was asked for one (two languages). */
export interface Judged {
    question: string;
    translation: string | null;
}

/** The "Q: …" lines of a reply, each with the "T: …" line after it (its translation) if there is one; anything else (an explanation instead of "—") is no question. */
export function questionsIn(reply: string): Judged[] {
    const found: Judged[] = [];
    for (const line of reply.split('\n').map((text) => text.trim())) {
        const label = line.slice(0, 2).toUpperCase();
        const text = line.slice(2).trim();
        if (label === 'Q:' && text !== '') found.push({ question: text, translation: null });
        else if (label === 'T:' && text !== '' && found.at(-1)?.translation === null) found.at(-1)!.translation = text;
    }
    return found;
}
