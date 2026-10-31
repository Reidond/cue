import { labelsFor } from './lexicon.ts';

// Finds the prepared questions and answers in a material's lines (ported from the Mac app's Materials.swift): a line with a question (or a
// question label) followed by a line that starts with an answer label, e.g. `12. How were the weights chosen? (Smith)` / `Answer: …`
// or `Q: …` / `A: …`. The answer runs until a blank line or a symbol-led line.

export interface Prepared {
    q: string;
    a: string;
    who: string | null;
    source: string;
}

/** A place to look for prepared answers: the whole text of a file, or one slide's speaker notes. */
export interface QaBlock {
    source: string;
    lines: string[];
}

const isLetter = (character: string) => /\p{L}/u.test(character);
const isNumber = (character: string) => /\p{N}/u.test(character);
const NEWLINES = /\r\n|[\n\r\u2028\u2029\u0085]/;
const trim = (text: string) => text.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, '');

/** Symbols, bullets and list numbering before the first word. */
function leadingNoise(line: string): number {
    let count = 0;
    for (const character of line) {
        if (isLetter(character) || character === '«' || character === '"' || character === '“') break;
        count += character.length;
    }
    return count;
}

/** Length of a leading label such as "Answer:", "A.", "❓ Q:" (symbols and numbering skipped). */
function labelLength(line: string, labels: string[]): number | undefined {
    const lead = leadingNoise(line);
    const rest = line.slice(lead).toLowerCase();
    for (const label of [...labels].sort((a, b) => b.length - a.length)) {
        if (!rest.startsWith(label)) continue;
        const after = rest.slice(label.length).replace(/^ +/, '');
        const mark = after[0];
        if (mark !== undefined && ':.)–—-'.includes(mark)) return lead + rest.length - after.length + 1;
    }
    return undefined;
}

function strip(line: string, labels: string[]): string {
    const length = labelLength(line, labels);
    return length === undefined ? line : trim(line.slice(length));
}

function startsWithSymbol(line: string): boolean {
    const first = line === '' ? undefined : String.fromCodePoint(line.codePointAt(0)!);
    return first !== undefined && !(isLetter(first) || isNumber(first) || '«"“('.includes(first));
}

function cleanQuestion(line: string, questionLabels: string[]): { question: string; who: string | null } {
    // A quoted question inside a note line: …: «How do you …?»
    const quoted = /[«“"](.+?\?)[»”"]/.exec(line);
    if (quoted) return { question: quoted[1]!, who: null };
    let text = strip(line, questionLabels);
    text = text.slice(leadingNoise(text));
    let who: string | null = null;
    const asker = /\?\s*\(([^()?]{2,40})\)\s*$/.exec(text);
    if (asker) {
        who = asker[1]!;
        text = `${text.slice(0, asker.index)}?`;
    }
    return { question: trim(text), who };
}

export function extractQA(rawLines: string[], language: string, source: string): Prepared[] {
    const { questionLabels, answerLabels } = labelsFor(language);
    const lines = rawLines.flatMap((line) => line.split(NEWLINES)).map(trim);
    const nextNonBlank = (index: number): number | undefined => {
        let next = index + 1;
        while (next < lines.length && lines[next] === '') next++;
        return next < lines.length ? next : undefined;
    };
    const opensPair = (index: number): number | undefined => {
        const line = lines[index]!;
        if (!(line.includes('?') || labelLength(line, questionLabels) !== undefined) || labelLength(line, answerLabels) !== undefined) return undefined;
        const next = nextNonBlank(index);
        return next !== undefined && labelLength(lines[next]!, answerLabels) !== undefined ? next : undefined;
    };

    const pairs: Prepared[] = [];
    let index = 0;
    while (index < lines.length) {
        const answerIndex = opensPair(index);
        if (answerIndex === undefined) {
            index++;
            continue;
        }
        const answer = [strip(lines[answerIndex]!, answerLabels)];
        let cursor = answerIndex + 1;
        while (cursor < lines.length && lines[cursor] !== '' && !startsWithSymbol(lines[cursor]!) && opensPair(cursor) === undefined) {
            answer.push(lines[cursor]!);
            cursor++;
        }
        const { question, who } = cleanQuestion(lines[index]!, questionLabels);
        const text = trim(answer.join(' '));
        if (question !== '' && text !== '') pairs.push({ q: question, a: text, who, source });
        index = cursor;
    }
    return pairs;
}

/** Markdown's emphasis and escapes out of a line, so `**Q:** How…?` reads as `Q: How…?` (toMarkdown writes Word and PDF files this way). */
export const unmark = (line: string) => line.replace(/(\*\*|__)/g, '').replace(/\\([\\`*_{}[\]()#+\-.!?<>|~])/g, '$1');
