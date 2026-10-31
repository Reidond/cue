// What the stand-ins for Claude reply — for the `claude` CLI (fake-claude.ts) and the Anthropic API
// (harness/fake-providers.ts) alike — and how they note what Cue sent them, as TIME-PID-KIND.txt in a
// folder, so cases can check it (see `Cue.claudeRequests`).
//
// FAKE_CLAUDE_ANSWER (text) and FAKE_CLAUDE_SUMMARY (a file) set the replies; FAKE_CLAUDE_ANSWERS (JSON
// `{"pattern": "answer"}`) answers a question matching a pattern (a regex, ignoring case) its own way.
// The judge finds the sentences of what was just said that end in "?", unless FAKE_CLAUDE_JUDGEMENTS
// (JSON `{"pattern": "reply"}`, the first pattern matching what was just said wins) gives its reply.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type Env = Record<string, string | undefined>;

/** Notes what Cue sent in `folder`; several processes can write at once, so time and pid name it. */
export function record(folder: string | undefined, kind: string, text: string): void {
    if (!folder) return;
    mkdirSync(folder, { recursive: true });
    const time = ((performance.timeOrigin + performance.now()) / 1000).toFixed(6);
    writeFileSync(join(folder, `${time}-${process.pid}-${kind}.txt`), text);
}

function readOrUndefined(file: string | undefined): string | undefined {
    if (file === undefined) return undefined;
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
}

/** A reply in the pieces it streams in: six words at a time. */
export function pieces(text: string): string[] {
    const words = text.split(' ');
    const result: string[] = [];
    for (let index = 0; index < words.length; index += 6) {
        result.push((index === 0 ? '' : ' ') + words.slice(index, index + 6).join(' '));
    }
    return result;
}

/** The answer session's reply to a message: "—" to a connection check. */
export function answer(content: string, env: Env): string {
    if (content.startsWith('Connection check')) return '—';
    const answers = Object.entries(JSON.parse(env['FAKE_CLAUDE_ANSWERS'] ?? '{}') as Record<string, string>);
    const question = /^Question: (.*)$/m.exec(content)?.[1] ?? '';
    const own = answers.find(([pattern]) => new RegExp(pattern, 'i').test(question))?.[1];
    return own ?? env['FAKE_CLAUDE_ANSWER'] ?? 'Fake answer from the end-to-end tests.\n- A supporting point\nSource: tests';
}

/** The judge's reply to a message: a "Q: …" line per question in what was just said, else "—". */
export function judgement(content: string, env: Env): string {
    if (content.startsWith('Connection check')) return '—';
    const said = content.split('Just said:\n')[1] ?? '';
    const own = Object.entries(JSON.parse(env['FAKE_CLAUDE_JUDGEMENTS'] ?? '{}') as Record<string, string>).find(([pattern]) =>
        new RegExp(pattern, 'i').test(said),
    )?.[1];
    if (own !== undefined) return own;
    const questions = said
        .split('\n')
        .map((line) => line.replace(/^\[[^\]]*\] /, ''))
        .join(' ')
        .split(/(?<=[.?!…])\s+/)
        .filter((sentence) => sentence.includes('?') && sentence.trim().split(/\s+/).length >= 2);
    return questions.length > 0 ? questions.map((question) => `Q: ${question.trim()}`).join('\n') : '—';
}

const defaultSummary = `# E2E rehearsal notes

## Summary
The participant asked when the report is due, and it was agreed to send it by Friday.

## Key points
- The report is due on Friday.

## Action items
- [ ] Speaker: send the report (Friday)`;

/** The notes a summary request gets. */
export function summary(env: Env): string {
    return readOrUndefined(env['FAKE_CLAUDE_SUMMARY']) ?? defaultSummary;
}
