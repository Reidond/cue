// What the stand-in for the Anthropic API (harness/fake-providers.ts) replies, and how it notes what the
// backend sent it, as TIME-PID-KIND.txt in a folder, so cases can check it (see `Cue.claudeRequests`).
//
// FAKE_CLAUDE_ANSWER (text) and FAKE_CLAUDE_SUMMARY (a file) set the replies, FAKE_CLAUDE_NAMES (JSON, label → name) the names found for the
// call's people (else the speaker lines of the summary file); FAKE_CLAUDE_ANSWERS (JSON
// `{"pattern": "answer"}`) answers a question matching a pattern (a regex, ignoring case) its own way.
// The judge finds the sentences of what was just said that end in "?", unless FAKE_CLAUDE_JUDGEMENTS
// (JSON `{"pattern": "reply"}`, the first pattern matching what was just said wins) gives its reply. A project's brief is
// FAKE_CLAUDE_BRIEF (the JSON object prompts/brief.md asks for), else one with nothing in it.
//
// Two languages: what is asked for in the other one (an answer's "» " lines, the judge's "T: " lines, a note's translation) is
// FAKE_CLAUDE_TRANSLATIONS (JSON `{"text": "its translation"}`, by the whole line) where it has the line, else the line after "(LANGUAGE) ";
// a note's translated summary is the FAKE_CLAUDE_TRANSLATED_SUMMARY file, else the summary with each line translated so.
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
    const text = own ?? env['FAKE_CLAUDE_ANSWER'] ?? 'Fake answer from the end-to-end tests.\n- A supporting point\nSource: tests';
    // Asked for each line in a second language too: an answer that has no "» " lines of its own gets them.
    const second = /write it in ([^ ]+) on a line of its own that starts with "» "/.exec(content)?.[1];
    if (!second || text.includes('\n» ')) return text;
    return text
        .split('\n')
        .flatMap((line) => [line, `» ${translated(line, second, env)}`])
        .join('\n');
}

/** A line in another language: FAKE_CLAUDE_TRANSLATIONS's, else marked with the language's name. */
export function translated(line: string, language: string, env: Env): string {
    const own = (JSON.parse(env['FAKE_CLAUDE_TRANSLATIONS'] ?? '{}') as Record<string, string>)[line.trim()];
    return own ?? `(${language}) ${line}`;
}

/** A translate request's reply: the title, the summary or the numbered lines it was given, in the language its system prompt names. */
export function translation(system: string, content: string, env: Env): string {
    const language = /into ([^:]+): its title/.exec(system)?.[1] ?? 'the other language';
    if (content.startsWith('Transcript:')) {
        return content
            .split('\n')
            .slice(1)
            .map((line) =>
                line.replace(/^(\d+)\. (.*)$/, (_, number: string, text: string) => `${number}. ${translated(text, language, env)}`),
            )
            .join('\n');
    }
    const title = /^Title: (.*)$/m.exec(content)?.[1] ?? '';
    const summary = content.split(/^Summary:\n/m)[1] ?? '';
    const own = readOrUndefined(env['FAKE_CLAUDE_TRANSLATED_SUMMARY']);
    const lines =
        own ??
        summary
            .split('\n')
            .map((line) => (line.trim() === '' || line.startsWith('#') ? line : translated(line, language, env)))
            .join('\n');
    return `Title: ${translated(title, language, env)}\n\nSummary:\n${lines}`;
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
    if (questions.length === 0) return '—';
    // Two languages: each question's translation, on a "T: " line after it.
    const second = /the question in ([^.)]+)\.\)/.exec(content)?.[1];
    return questions
        .map((question) => `Q: ${question.trim()}${second ? `\nT: ${translated(question.trim(), second, env)}` : ''}`)
        .join('\n');
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

/** The speaker lines of a summary file: `<!-- speaker: LABEL = NAME -->`, the way the names prompt asks for them. */
function speakerLines(text: string): string[] {
    return text.split('\n').filter((line) => /^\s*<!--\s*speaker:/.test(line));
}

/** The names a names request gets: FAKE_CLAUDE_NAMES (JSON, label → name) as speaker lines, else those of the FAKE_CLAUDE_SUMMARY file. */
export function names(env: Env): string {
    const own = env['FAKE_CLAUDE_NAMES'];
    if (own !== undefined) {
        return Object.entries(JSON.parse(own) as Record<string, string>)
            .map(([label, name]) => `<!-- speaker: ${label} = ${name} -->`)
            .join('\n');
    }
    return speakerLines(readOrUndefined(env['FAKE_CLAUDE_SUMMARY']) ?? '').join('\n');
}

/** The brief written from a project's materials: FAKE_CLAUDE_BRIEF, else nothing (no occasion, names and terms or answers). */
export function brief(env: Env): string {
    return env['FAKE_CLAUDE_BRIEF'] ?? '{"occasion": "", "namesAndTerms": [], "answers": []}';
}
