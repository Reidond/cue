import judgeTemplate from '../../prompts/judge.md?raw';
import promptTemplate from '../../prompts/prompt.md?raw';
import type { CallLexicon } from './lexicon.ts';

// What Claude knows during a call: its system prompt (the speaker, the occasion, the project's prepared answers and materials), and the
// match of a question against the prepared answers. The port of the Mac app's `KnowledgeBase`.

export interface PreparedAnswer {
    q: string;
    a: string;
    who: string | null;
    source: string;
}

export interface Speaker {
    speaker: string;
    occasion: string;
}

const speakerOf = (speaker: string) => (speaker.trim() === '' ? 'the speaker' : speaker.trim());
const occasionOf = (occasion: string) => (occasion.trim() === '' ? 'a talk followed by questions.' : occasion.trim());

/** Claude's system prompt: prompt.md filled in, then the prepared answers, then the materials' texts. */
export function answerPrompt(who: Speaker, lexicon: CallLexicon, prepared: PreparedAnswer[], texts: string[]): string {
    let prompt = promptTemplate
        .replaceAll('{{speaker}}', speakerOf(who.speaker))
        .replaceAll('{{occasion}}', occasionOf(who.occasion))
        .replaceAll('{{language}}', lexicon.name)
        .replaceAll('{{numbersLabel}}', lexicon.numbersLabel)
        .replaceAll('{{sourceLabel}}', lexicon.sourceLabel);
    if (prepared.length > 0) {
        prompt += '\n\n# PREPARED ANSWERS\n';
        for (const item of prepared) prompt += `\nQuestion${item.who ? ` (${item.who})` : ''}: ${item.q}\nAnswer: ${item.a}\n`;
    }
    const present = texts.filter((text) => text !== '');
    prompt +=
        present.length === 0
            ? '\n\n# MATERIALS\n\nNo materials were provided. Answer from general knowledge and say when you are unsure.\n'
            : `\n\n# MATERIALS\n\n${present.join('\n\n')}`;
    return prompt;
}

/** The judge's system prompt: judge.md filled in. */
export function judgePrompt(who: Speaker, lexicon: CallLexicon): string {
    return judgeTemplate
        .replaceAll('{{speaker}}', speakerOf(who.speaker))
        .replaceAll('{{occasion}}', occasionOf(who.occasion))
        .replaceAll('{{language}}', lexicon.name);
}

/** Crude stemming that works well enough across European languages: lowercase, words of 4+ letters that are not stop words, cut to 6 letters. */
export function stems(text: string, stopWords: Set<string>): string[] {
    return text
        .toLowerCase()
        .replaceAll('’', "'")
        .split(/[^\p{L}\p{N}'-]+/u)
        .filter((word) => Array.from(word).length >= 4 && !stopWords.has(word))
        .map((word) => Array.from(word).slice(0, 6).join(''));
}

/** The prepared answers of a call, ready to be matched against questions by IDF-weighted stem overlap. */
export class Matcher {
    readonly prepared: PreparedAnswer[];
    readonly #stopWords: Set<string>;
    readonly #questionStems: Set<string>[];
    readonly #idf = new Map<string, number>();

    constructor(prepared: PreparedAnswer[], stopWords: Set<string>) {
        this.prepared = prepared;
        this.#stopWords = stopWords;
        this.#questionStems = prepared.map((item) => new Set(stems(item.q, stopWords)));
        const frequency = new Map<string, number>();
        for (const set of this.#questionStems) for (const stem of set) frequency.set(stem, (frequency.get(stem) ?? 0) + 1);
        for (const [stem, count] of frequency) this.#idf.set(stem, Math.log((prepared.length + 1) / count) + 0.5);
    }

    /** The best prepared answer for a question, or none. */
    match(question: string): { answer: PreparedAnswer; score: number } | null {
        const query = new Set(stems(question, this.#stopWords));
        let queryWeight = 0;
        for (const stem of query) queryWeight += this.#idf.get(stem) ?? 1.5;
        if (queryWeight <= 0) return null;
        let best: { index: number; score: number } | undefined;
        this.#questionStems.forEach((candidate, index) => {
            let shared = 0,
                candidateWeight = 0;
            for (const stem of candidate) {
                const weight = this.#idf.get(stem) ?? 0;
                candidateWeight += weight;
                if (query.has(stem)) shared += weight;
            }
            // Harmonic mean of coverage in both directions, so neither a short nor a long question wins by size.
            const a = shared / queryWeight,
                b = shared / Math.max(candidateWeight, 0.001);
            const score = a + b > 0 ? (2 * a * b) / (a + b) : 0;
            if (score > (best?.score ?? 0)) best = { index, score };
        });
        if (!best || best.score < 0.3) return null;
        return { answer: this.prepared[best.index]!, score: best.score };
    }
}

/** The first sentence of a prepared answer, without its thanks: what to say the instant the question lands. */
export function firstSentence(text: string, dropping: string): string | null {
    const cleaned = dropping === '' ? text : text.replaceAll(dropping, '');
    const end = cleaned.search(/[.!?]/);
    if (end < 0) return cleaned === '' ? null : cleaned;
    return cleaned.slice(0, end + 1);
}

/** Whether a microphone line is a near-copy of a participant line (the microphone picking up the call through speakers). */
export function isEcho(text: string, of: string, stopWords: Set<string>): boolean {
    const words = new Set(stems(text, stopWords));
    if (words.size < 3) return false;
    const other = new Set(stems(of, stopWords));
    let shared = 0;
    for (const word of words) if (other.has(word)) shared++;
    return shared / words.size > 0.6;
}
