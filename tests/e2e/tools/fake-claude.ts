#!/usr/bin/env node
// Stand-in for the `claude` CLI in end-to-end tests (Cue finds it through CUE_CLAUDE_BIN; the harness
// puts the Node that runs the cases first on Cue's PATH). Speaks the stream-json protocol Cue uses and
// records every request in FAKE_CLAUDE_LOG as TIME-PID-KIND.txt, so cases can check what Cue sent.
//
//   answer session (`--input-format stream-json`): answer-system, ask
//   question judge (the same, with `--system-prompt-file …/judge.md`): judge-system, judge
//   one-shot summary (`-p` with the transcript on stdin): summary-system, summary-input
//
// FAKE_CLAUDE_ANSWER (text) and FAKE_CLAUDE_SUMMARY (a file) set the replies; FAKE_CLAUDE_ANSWERS (JSON
// `{"pattern": "answer"}`) answers a question matching a pattern (a regex, ignoring case) its own way;
// FAKE_CLAUDE_SUMMARY_DELAY (seconds) makes the summary take that long, like the real one.
// The judge finds the sentences of what was just said that end in "?", unless FAKE_CLAUDE_JUDGEMENTS
// (JSON `{"pattern": "reply"}`, the first pattern matching what was just said wins) gives its reply;
// FAKE_CLAUDE_JUDGE_FAILS=1 makes it fail every request, its warm-up too.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';

const args = process.argv.slice(2);
const env = process.env;

function valueAfter(flag: string): string | undefined {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
}

function readOrUndefined(file: string | undefined): string | undefined {
    if (file === undefined) return undefined;
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
}

function record(kind: string, text: string): void {
    const folder = env['FAKE_CLAUDE_LOG'];
    if (!folder) return;
    mkdirSync(folder, { recursive: true });
    // Several processes can write at once; time (to the microsecond) and pid keep names unique and in order.
    const time = ((performance.timeOrigin + performance.now()) / 1000).toFixed(6);
    writeFileSync(join(folder, `${time}-${process.pid}-${kind}.txt`), text);
}

function emit(event: object): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Streams `text` in a few deltas, then the final result. */
function reply(text: string): void {
    const words = text.split(' ');
    for (let index = 0; index < words.length; index += 6) {
        const piece = words.slice(index, index + 6).join(' ');
        emit({ type: 'stream_event', event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: (index === 0 ? '' : ' ') + piece },
        } });
    }
    emit({ type: 'result', subtype: 'success', is_error: false, result: text });
}

const defaultSummary = `# E2E rehearsal notes

## Summary
The participant asked when the report is due, and it was agreed to send it by Friday.

## Key points
- The report is due on Friday.

## Action items
- [ ] Speaker: send the report (Friday)`;

/** A message Cue sent the session: `{"type": "user", "message": {"role": "user", "content": TEXT}}`. */
function contentOf(line: string): string | undefined {
    try {
        const content: unknown = JSON.parse(line)?.message?.content;
        return typeof content === 'string' ? content : undefined;
    } catch {
        return undefined;
    }
}

/** The judge's reply to a message: a "Q: …" line per question in what was just said, else "—". */
function judgement(content: string): string {
    const said = content.split('Just said:\n')[1] ?? '';
    const own = Object.entries(JSON.parse(env['FAKE_CLAUDE_JUDGEMENTS'] ?? '{}') as Record<string, string>)
        .find(([pattern]) => new RegExp(pattern, 'i').test(said))?.[1];
    if (own !== undefined) return own;
    const questions = said.split('\n').map((line) => line.replace(/^\[[^\]]*\] /, '')).join(' ')
        .split(/(?<=[.?!…])\s+/).filter((sentence) => sentence.includes('?') && sentence.trim().split(/\s+/).length >= 2);
    return questions.length > 0 ? questions.map((question) => `Q: ${question.trim()}`).join('\n') : '—';
}

if (valueAfter('--input-format') === 'stream-json') {
    const systemFile = valueAfter('--system-prompt-file');
    const judging = systemFile !== undefined && basename(systemFile) === 'judge.md';
    if (systemFile !== undefined) record(judging ? 'judge-system' : 'answer-system', readOrUndefined(systemFile) ?? '');
    emit({ type: 'system', subtype: 'init' });
    const answer = env['FAKE_CLAUDE_ANSWER'] ?? 'Fake answer from the end-to-end tests.\n- A supporting point\nSource: tests';
    const answers = Object.entries(JSON.parse(env['FAKE_CLAUDE_ANSWERS'] ?? '{}') as Record<string, string>);
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
        const content = contentOf(line);
        if (content === undefined) continue;
        if (judging) {
            record('judge', content);
            if (env['FAKE_CLAUDE_JUDGE_FAILS'] === '1') {
                emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'The judge failed' });
            } else {
                reply(content.startsWith('Connection check') ? '—' : judgement(content));
            }
            continue;
        }
        record('ask', content);
        const question = /^Question: (.*)$/m.exec(content)?.[1] ?? '';
        const own = answers.find(([pattern]) => new RegExp(pattern, 'i').test(question))?.[1];
        reply(content.startsWith('Connection check') ? '—' : own ?? answer);
    }
} else {
    record('summary-system', readOrUndefined(valueAfter('--system-prompt-file')) ?? valueAfter('--system-prompt') ?? '');
    let input = '';
    for await (const chunk of process.stdin.setEncoding('utf8')) input += chunk;
    record('summary-input', input);
    const summary = readOrUndefined(env['FAKE_CLAUDE_SUMMARY']) ?? defaultSummary;
    const delay = Number(env['FAKE_CLAUDE_SUMMARY_DELAY']);
    if (delay > 0) await sleep(delay * 1000);
    reply(summary);
}
