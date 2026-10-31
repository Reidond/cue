// Decides when the participants have finished asking something, and what they asked. The port of the Mac app's `QuestionDetector`.
//
// Participant utterances collect into a buffer, and each time one is added the judge (Claude Haiku, see judge.ts) reads the buffer and says which
// questions in it are for the speaker. Once it has found some, the detector fires when the participants have been quiet for `QUIET_GAP_MS` since
// they stopped talking, or as soon as the presenter starts talking (they are answering). New participant speech postpones it and is judged again
// with the rest. Talk the judge finds no question in never fires. Without a judge, sentences ending in "?" count.

export interface Line {
    label: string;
    text: string;
    /** When the utterance was said (milliseconds since the epoch). */
    started: number;
}

const QUIET_GAP_MS = 1800;
/** Utterances separated by a long silence belong to different exchanges. */
const EXCHANGE_GAP_MS = 45_000;
/** Only the end of a long talk can hold its question. */
const MAX_BUFFERED = 8;

export class QuestionDetector {
    /** The questions asked in one go, in order. */
    onQuestions: (questions: string[]) => void = () => {};
    /** Reads what was just said (an utterance per line, "[Label] text") and returns its questions for the speaker (none: []), or null when it couldn't tell. */
    judge: ((speech: string) => Promise<string[] | null>) | undefined;

    /** What was said since the last question, judged as a whole each time it grows. */
    buffer: Line[] = [];
    /** Counts the buffer's changes, so a verdict on an older buffer is dropped. */
    #version = 0;
    /** The judge's verdict on the buffer as it is; undefined while it is still judging. */
    #questions: string[] | undefined;
    /** When the participants last stopped talking, while they are quiet. */
    #quietSince: number | undefined;
    /** When the participants last started talking. */
    #lastOnset = 0;
    /** The presenter started answering before the verdict came. */
    #fireWhenJudged = false;
    #lastAdded = 0;
    #timer: ReturnType<typeof setTimeout> | undefined;

    /** A finished utterance (`label` is who said it, as the transcript shows them). */
    add(text: string, label: string, speechStarted: number, speechEnded: number): void {
        if (Date.now() - this.#lastAdded > EXCHANGE_GAP_MS) this.buffer = [];
        this.buffer.push({ label, text, started: speechStarted });
        if (this.buffer.length > MAX_BUFFERED) this.buffer.splice(0, this.buffer.length - MAX_BUFFERED);
        this.#lastAdded = Date.now();
        this.#version++;
        this.#questions = undefined;
        const asked = this.#version;
        const speech = this.buffer.map((line) => `[${line.label}] ${line.text}`).join('\n');
        const marked = markedQuestions(this.buffer.map((line) => line.text).join(' '));
        if (this.judge) {
            void this.judge(speech).then(
                (found) => {
                    if (asked === this.#version) this.#judged(found ?? marked);
                },
                () => {
                    if (asked === this.#version) this.#judged(marked);
                },
            );
        } else {
            this.#judged(marked);
        }
        this.participantsStopped(speechEnded);
    }

    /** Participants went quiet (also after a noise blip that produced no text). */
    participantsStopped(speechEnded: number): void {
        // They may have started again while this was being transcribed.
        if (this.#lastOnset >= speechEnded) return;
        this.#quietSince = speechEnded;
        this.#schedule();
    }

    /** Participants started talking again: the question may go on. */
    participantsSpeaking(): void {
        this.#lastOnset = Date.now();
        clearTimeout(this.#timer);
        this.#quietSince = undefined;
        // They go on, so the presenter's word over what they said before was not an answer.
        this.#fireWhenJudged = false;
    }

    /** The presenter started talking, so the question is over. */
    presenterSpeaking(): void {
        if (this.#questions === undefined && this.buffer.length > 0) this.#fireWhenJudged = true;
        else this.#fire();
    }

    /** Everything collected so far and its questions (the judge's, if it has spoken), used by the manual "answer now". */
    take(): { speech: string; questions: string[] } | null {
        const buffer = this.buffer;
        const questions = this.#questions;
        this.#clear();
        if (buffer.length === 0) return null;
        const speech = buffer.map((line) => line.text).join(' ');
        return { speech, questions: questions ?? markedQuestions(speech) };
    }

    /** Stops everything (the call is over). */
    stop(): void {
        this.#clear();
    }

    #judged(found: string[]): void {
        this.#questions = found;
        const answering = this.#fireWhenJudged;
        this.#fireWhenJudged = false;
        if (answering && found.length > 0) this.#fire();
        else this.#schedule();
    }

    #schedule(): void {
        clearTimeout(this.#timer);
        if (!this.#questions || this.#questions.length === 0 || this.#quietSince === undefined) return;
        const delay = Math.max(50, QUIET_GAP_MS - (Date.now() - this.#quietSince));
        this.#timer = setTimeout(() => this.#fire(), delay);
    }

    #fire(): void {
        const found = this.#questions;
        if (!found || found.length === 0) return;
        this.#clear();
        this.onQuestions(found);
    }

    #clear(): void {
        clearTimeout(this.#timer);
        this.buffer = [];
        this.#questions = undefined;
        this.#fireWhenJudged = false;
        this.#version++;
    }
}

const wordsOf = (text: string) => text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);

/** Without the judge: sentences ending in "?" that are more than a tag ("Right?"). */
export function markedQuestions(text: string): string[] {
    return sentences(text).filter((sentence) => sentence.includes('?') && wordsOf(sentence).length >= 2);
}

/** Sentences, each with its own end mark (and closing quote); a full stop inside a number does not end one. */
export function sentences(text: string): string[] {
    const found: string[] = [];
    const characters = Array.from(text);
    let current = '';
    for (let index = 0; index < characters.length; index++) {
        current += characters[index];
        if ('.?!…'.includes(characters[index]!)) {
            while (index + 1 < characters.length && '.?!…»”")'.includes(characters[index + 1]!)) {
                index++;
                current += characters[index];
            }
            if (index + 1 === characters.length || /\s/.test(characters[index + 1]!)) {
                found.push(current.trim());
                current = '';
            }
        }
    }
    const rest = current.trim();
    if (rest !== '') found.push(rest);
    return found;
}
