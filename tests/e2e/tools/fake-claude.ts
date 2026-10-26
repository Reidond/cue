#!/usr/bin/env node
// Stand-in for the `claude` CLI in end-to-end tests (Cue finds it through CUE_CLAUDE_BIN; the harness
// puts the Node that runs the cases first on Cue's PATH). Speaks the stream-json protocol Cue uses and
// records every request in FAKE_CLAUDE_LOG as TIME-PID-KIND.txt, so cases can check what Cue sent.
//
//   answer session (`--input-format stream-json`): answer-system, ask
//   question judge (the same, with `--system-prompt-file …/judge.md`): judge-system, judge
//   one-shot summary (`-p` with the transcript on stdin): summary-system, summary-input
//
// The replies are fake-replies.ts's, set by the FAKE_CLAUDE_* variables it describes;
// FAKE_CLAUDE_SUMMARY_DELAY (seconds) makes the summary take that long, like the real one.
// FAKE_CLAUDE_JUDGE_FAILS=1 makes the judge fail every request, its warm-up too, and
// FAKE_CLAUDE_JUDGE_DELAY (seconds) makes each verdict take that long.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { answer, judgement, pieces, record as recordIn, summary } from './fake-replies.ts';

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
    recordIn(env['FAKE_CLAUDE_LOG'], kind, text);
}

function emit(event: object): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Streams `text` in a few deltas, then the final result. */
function reply(text: string): void {
    for (const piece of pieces(text)) {
        emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
    }
    emit({ type: 'result', subtype: 'success', is_error: false, result: text });
}

/** A message Cue sent the session: `{"type": "user", "message": {"role": "user", "content": TEXT}}`. */
function contentOf(line: string): string | undefined {
    try {
        const content: unknown = JSON.parse(line)?.message?.content;
        return typeof content === 'string' ? content : undefined;
    } catch {
        return undefined;
    }
}

if (valueAfter('--input-format') === 'stream-json') {
    const systemFile = valueAfter('--system-prompt-file');
    const judging = systemFile !== undefined && basename(systemFile) === 'judge.md';
    if (systemFile !== undefined) record(judging ? 'judge-system' : 'answer-system', readOrUndefined(systemFile) ?? '');
    emit({ type: 'system', subtype: 'init' });
    for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
        const content = contentOf(line);
        if (content === undefined) continue;
        if (judging) {
            record('judge', content);
            if (env['FAKE_CLAUDE_JUDGE_FAILS'] === '1') {
                emit({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'The judge failed' });
                continue;
            }
            const delay = Number(env['FAKE_CLAUDE_JUDGE_DELAY']);
            if (delay > 0 && !content.startsWith('Connection check')) await sleep(delay * 1000);
            reply(judgement(content, env));
            continue;
        }
        record('ask', content);
        reply(answer(content, env));
    }
} else {
    record('summary-system', readOrUndefined(valueAfter('--system-prompt-file')) ?? valueAfter('--system-prompt') ?? '');
    let input = '';
    for await (const chunk of process.stdin.setEncoding('utf8')) input += chunk;
    record('summary-input', input);
    const delay = Number(env['FAKE_CLAUDE_SUMMARY_DELAY']);
    if (delay > 0) await sleep(delay * 1000);
    reply(summary(env));
}
