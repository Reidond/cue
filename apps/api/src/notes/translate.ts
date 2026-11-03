import translateTemplate from '../../prompts/translate.md?raw';

// The translation of a note into the other of the person's two languages (the notes Workflow's `translate` step): the title and the summary in
// one request, the transcript in batches of numbered lines, so that a long call is never one reply too long to finish.

/** Lines of the transcript per request. */
export const TRANSLATE_BATCH = 150;

export const translatePrompt = (language: string, labels: string[]) =>
    translateTemplate.replaceAll('{{language}}', language).replaceAll('{{labels}}', labels.length > 0 ? labels.join(', ') : 'none');

/** The message for the title and the summary. */
export const summaryMessage = (title: string, summary: string) => `Title: ${title}\n\nSummary:\n${summary}`;

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
