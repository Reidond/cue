import translateTemplate from '../../prompts/translate.md?raw';

// The translation of a note into the other of the person's two languages (the notes Workflow's `translate` step): the title and the summary in
// one request, the transcript in batches of numbered lines, so that a long call is never one reply too long to finish. A batch is bounded by its
// text as well as its lines, and a turn longer than a piece (one speaker talking for minutes) goes in pieces, cut between sentences.

/** Lines of the transcript per request, at most. */
export const TRANSLATE_BATCH = 150;
/** Characters of transcript per request, at most: about 2,500 tokens, so the reply (longer in some languages) is far from `max_tokens`. */
export const TRANSLATE_BATCH_CHARS = 8000;
/** A turn longer than this is translated in pieces. */
const PIECE_CHARS = 1500;

/** A turn's text in pieces of at most PIECE_CHARS, cut after a sentence where one ends, else at a space. */
export function piecesOf(text: string): string[] {
    const pieces: string[] = [];
    let rest = text.replace(/\n/g, ' ').trim();
    while (rest.length > PIECE_CHARS) {
        const window = rest.slice(0, PIECE_CHARS);
        const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
        const space = window.lastIndexOf(' ');
        const cut = sentence > PIECE_CHARS / 3 ? sentence + 1 : space > 0 ? space : PIECE_CHARS;
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
    }
    if (rest !== '') pieces.push(rest);
    return pieces;
}

/** The pieces of all the turns (each with its turn's index), in batches bounded by TRANSLATE_BATCH lines and TRANSLATE_BATCH_CHARS characters. */
export function batchesOf(turns: string[]): { turn: number; text: string }[][] {
    const batches: { turn: number; text: string }[][] = [];
    let batch: { turn: number; text: string }[] = [];
    let size = 0;
    turns.forEach((text, turn) => {
        for (const piece of piecesOf(text)) {
            if (batch.length > 0 && (batch.length >= TRANSLATE_BATCH || size + piece.length > TRANSLATE_BATCH_CHARS)) {
                batches.push(batch);
                batch = [];
                size = 0;
            }
            batch.push({ turn, text: piece });
            size += piece.length;
        }
    });
    if (batch.length > 0) batches.push(batch);
    return batches;
}

export const translatePrompt = (language: string, labels: string[]) =>
    translateTemplate.replaceAll('{{language}}', language).replaceAll('{{labels}}', labels.length > 0 ? labels.join(', ') : 'none');

/** The message for the title and the summary (the title alone when there is no summary). */
export const summaryMessage = (title: string, summary: string) =>
    summary.trim() === '' ? `Title: ${title}` : `Title: ${title}\n\nSummary:\n${summary}`;

/** The message for some lines of the transcript, numbered from 1. */
export const linesMessage = (lines: string[]) =>
    `Transcript:\n${lines.map((line, index) => `${index + 1}. ${line.replace(/\n/g, ' ')}`).join('\n')}`;

/** The title and the summary of a reply; what is missing stays as it was. */
export function summaryOf(reply: string, title: string, summary: string): { title: string; summary: string } {
    const titled = /^Title:\s*(.*)$/m.exec(reply)?.[1]?.trim();
    const at = reply.search(/^Summary:\s*$/m);
    const translated =
        at < 0
            ? ''
            : reply
                  .slice(at)
                  .replace(/^Summary:\s*\n?/, '')
                  .split(/^Transcript:\s*$/m)[0]!
                  .trim();
    return { title: titled || title, summary: translated || summary };
}

/** The numbered lines of a reply, \`count\` of them; one that is missing is empty (the client shows the line alone). */
export function linesOf(reply: string, count: number): string[] {
    const found = new Map<number, string>();
    for (const match of reply.matchAll(/^\s*(\d+)[.)]\s*(.*)$/gm)) found.set(Number(match[1]), match[2]!.trim());
    return Array.from({ length: count }, (_, index) => found.get(index + 1) ?? '');
}
