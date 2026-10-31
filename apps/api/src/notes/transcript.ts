import type { Turn } from '@cue/contract';
import { isEcho } from '../call/knowledge.ts';
import type { NoteLexicon } from './lexicon.ts';

// A note's transcript: lines (what was said, when, by which side and voice), the voices heard on the call side, and the arithmetic between
// them. The ports of the Mac app's `CallTranscript`, `Speakers.label` and the parts of `RecordingStore` that judged a second pass.
// Times are seconds since the recording began.

export type Channel = 'me' | 'others';

export interface Line {
    channel: Channel;
    /** Which voice on the call side (1, 2, …) when they were told apart. */
    speaker: number | null;
    text: string;
    start: number;
    end: number;
}

/** One stretch of one voice on the call side. */
export interface Voice {
    voice: string;
    start: number;
    end: number;
}

/** Pauses of less than this keep consecutive lines of one voice in one paragraph. */
const TURN_GAP_SECONDS = 4;

/** Consecutive lines from the same side and voice with short pauses become one turn; `label` says who it is. */
export function turnsOf(lines: Line[], label: (channel: Channel, speaker: number | null) => string): Turn[] {
    const turns: (Turn & { end: number })[] = [];
    for (const line of lines.toSorted((a, b) => a.start - b.start)) {
        const last = turns.at(-1);
        if (last && last.channel === line.channel && last.speaker === line.speaker && line.start - last.end < TURN_GAP_SECONDS) {
            last.text += ` ${line.text}`;
            last.end = line.end;
        } else {
            turns.push({
                channel: line.channel,
                speaker: line.speaker,
                label: label(line.channel, line.speaker),
                start: line.start,
                text: line.text,
                end: line.end,
            });
        }
    }
    return turns.map(({ end: _end, ...turn }) => turn);
}

/** 00:12:05. */
export function clock(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const two = (value: number) => String(value).padStart(2, '0');
    return `${two(Math.floor(total / 3600))}:${two(Math.floor(total / 60) % 60)}:${two(total % 60)}`;
}

/** What Claude reads: `[00:00:06] [Андрій Тест] text`, one turn a line. */
export const plainText = (turns: Turn[]) => turns.map((turn) => `[${clock(turn.start)}] [${turn.label}] ${turn.text}`).join('\n');

/** 0:42, 12:05 or 1:02:03: how long audio is, in a log line. */
export function length(seconds: number): string {
    const total = Math.max(0, Math.round(seconds));
    const two = (value: number) => String(value).padStart(2, '0');
    return total >= 3600
        ? `${Math.floor(total / 3600)}:${two(Math.floor(total / 60) % 60)}:${two(total % 60)}`
        : `${Math.floor(total / 60)}:${two(total % 60)}`;
}

/**
 * Gives each call-side line the voice heard most while it was said (the nearest one when none was), numbered 1, 2, … in the order they first
 * speak. Returns how many voices speak in the transcript; with fewer than two the lines are returned as they were.
 */
export function labelVoices(lines: Line[], voices: Voice[]): { lines: Line[]; count: number } {
    const distance = (voice: Voice, start: number, end: number) => Math.max(voice.start - end, start - voice.end, 0);
    const numbers = new Map<string, number>();
    const labelled = lines.map((line) => ({ ...line }));
    for (const line of labelled) {
        if (line.channel !== 'others') continue;
        const start = line.start;
        const end = Math.max(start, line.end);
        const heard = new Map<string, number>();
        for (const voice of voices) {
            if (voice.end > start && voice.start < end) {
                heard.set(voice.voice, (heard.get(voice.voice) ?? 0) + Math.min(voice.end, end) - Math.max(voice.start, start));
            }
        }
        // Ties go the same way every time: to the smaller voice.
        let best: string | undefined;
        for (const [voice, seconds] of heard) {
            if (best === undefined || seconds > heard.get(best)! || (seconds === heard.get(best) && voice < best)) best = voice;
        }
        best ??= voices.reduce<Voice | undefined>(
            (nearest, voice) => (!nearest || distance(voice, start, end) < distance(nearest, start, end) ? voice : nearest),
            undefined,
        )?.voice;
        if (best === undefined) continue;
        if (!numbers.has(best)) numbers.set(best, numbers.size + 1);
        line.speaker = numbers.get(best)!;
    }
    return numbers.size > 1 ? { lines: labelled, count: numbers.size } : { lines, count: numbers.size };
}

const wordsOf = (lines: Line[], channel: Channel) =>
    lines.filter((line) => line.channel === channel).reduce((total, line) => total + line.text.split(/\s+/).filter(Boolean).length, 0);

/**
 * The side on which the second pass lost more than a quarter of the words live recognition heard (a wrong language, a cut-off run, nothing
 * but hallucinations), if any: the live transcript is the better one then. A good pass stays within a few percent of the live word count.
 */
export function sideLost(live: Line[], improved: Line[]): string | null {
    for (const channel of ['me', 'others'] as const) {
        const before = wordsOf(live, channel);
        const after = wordsOf(improved, channel);
        if (before >= 8 && after * 4 < before * 3) return channel === 'me' ? 'your side' : 'the call side';
    }
    return null;
}

/** With speakers instead of headphones the microphone also hears the call: drops those copies. */
export function withoutEchoes(lines: Line[], stopWords: Set<string>): Line[] {
    const others = lines.filter((line) => line.channel === 'others');
    return lines.filter(
        (line) =>
            line.channel !== 'me' ||
            !others.some((other) => other.start < line.end + 1 && other.end > line.start - 1 && isEcho(line.text, other.text, stopWords)),
    );
}

/** Every whole-word `old` in `text` (not part of a longer word or number: «Учасник 1» isn't «Учасник 12»). */
export function replacingName(old: string, name: string, text: string): string {
    if (old === '') return text;
    const isWordCharacter = (character: string | undefined) => character !== undefined && /[\p{L}\p{N}]/u.test(character);
    let result = '';
    let from = 0;
    for (;;) {
        const found = text.indexOf(old, from);
        if (found < 0) break;
        const before = Array.from(text.slice(0, found)).at(-1);
        const after = Array.from(text.slice(found + old.length))[0];
        result += text.slice(from, found) + (!isWordCharacter(before) && !isWordCharacter(after) ? name : old);
        from = found + old.length;
    }
    return result + text.slice(from);
}

// MARK: Summaries

/**
 * The names the model suggests for the people on the call, as `<!-- speaker: LABEL = NAME -->` lines, for those of `labels`; returns the text
 * without them (and without any other comment line).
 */
export function nameSuggestions(text: string, labels: string[]): { text: string; names: Record<string, string> } {
    const names: Record<string, string> = {};
    const kept = text.split('\n').filter((line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('<!--')) return true;
        const match = /^<!--\s*speaker:\s*(.+?)\s*=\s*(.+?)\s*-->$/.exec(trimmed);
        if (match && labels.includes(match[1]!) && match[2] !== match[1]) names[match[1]!] = match[2]!.replaceAll(',', '');
        return false;
    });
    return { text: kept.join('\n'), names };
}

function closingParenthesis(characters: string[], open: number): number | null {
    let depth = 0;
    for (let index = open; index < characters.length; index++) {
        if (characters[index] === '(') depth++;
        if (characters[index] === ')') depth--;
        if (depth === 0) return index;
    }
    return null;
}

/** Whether the text has one of the words, at the start of a word ("транскрипт" in «транскрипті»). */
function mentions(text: string, words: string[]): boolean {
    const lower = text.toLowerCase();
    return words.some((word) => {
        for (let from = lower.indexOf(word); from >= 0; from = lower.indexOf(word, from + 1)) {
            if (from === 0 || !/\p{L}/u.test(lower[from - 1]!)) return true;
        }
        return false;
    });
}

/**
 * The safety net for the summary prompt's rule: drops parenthetical remarks that mention the transcript or recognition, as in
 * «до п'ятниці (у транскрипті — „дотатниці“)». Returns the summary and the remarks dropped.
 */
export function droppingTranscriptRemarks(summary: string, words: string[]): { text: string; dropped: string[] } {
    if (words.length === 0) return { text: summary, dropped: [] };
    const dropped: string[] = [];
    const lines: string[] = [];
    for (const line of summary.split('\n')) {
        const characters = Array.from(line);
        let index = 0;
        let changed = false;
        while (index < characters.length) {
            // A parenthesis right after `]` is a link's address.
            const close =
                characters[index] === '(' && (index === 0 || characters[index - 1] !== ']') ? closingParenthesis(characters, index) : null;
            if (close === null || !mentions(characters.slice(index + 1, close).join(''), words)) {
                index++;
                continue;
            }
            dropped.push(characters.slice(index, close + 1).join(''));
            let start = index;
            let end = close + 1;
            // An italic remark, `_(…)_`, goes with its markers.
            if (
                start > 0 &&
                end < characters.length &&
                '_*'.includes(characters[start - 1]!) &&
                characters[end] === characters[start - 1]
            ) {
                start--;
                end++;
            }
            while (start > 0 && characters[start - 1] === ' ') start--;
            if (start === 0) while (end < characters.length && characters[end] === ' ') end++;
            characters.splice(start, end - start);
            changed = true;
            index = start;
        }
        const cleaned = characters.join('');
        // A list item or quote that was nothing but the remark goes altogether.
        if (changed && ['', '-', '*', '+', '>', '- [ ]', '- [x]'].includes(cleaned.trim())) continue;
        lines.push(cleaned);
    }
    return { text: lines.join('\n'), dropped };
}

/** The title of a summary: its first `# ` line. */
export function titleOf(summary: string): string | null {
    const line = summary.split('\n').find((candidate) => candidate.startsWith('# '));
    const title = line?.slice(2).trim();
    return title ? title : null;
}

/** The summary without its title (and the blank lines before the first section). */
export function withoutTitle(summary: string): string {
    const lines = summary.split('\n');
    let skip = 0;
    while (skip < lines.length && (lines[skip]!.trim() === '' || lines[skip]!.startsWith('# '))) skip++;
    return lines.slice(skip).join('\n').trim();
}

/** The labels a note is made of, from the summary prompt's point of view: the people on the call. */
export function labelsOf(lexicon: NoteLexicon, participants: string[]): string[] {
    return participants.slice(1).filter((name) => lexicon.isLabel(name));
}
