#!/usr/bin/env node
// Runs Cue's end-to-end cases against the built app.
//
//   node tests/e2e/run.ts [--no-build] [--real-claude] [--keep] [PREFIX…]
//
//   --no-build     use the existing build/Cue.app
//   --real-claude  use the real `claude` CLI instead of tools/fake-claude.ts
//   --keep         keep every case's sandbox (failed cases are always kept)
//   PREFIX…        run only cases whose file name starts with one of these
//
// Exit status: 0 when nothing failed (skips are fine), 1 otherwise.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, appendFileSync, constants, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { run } from 'node:test';

const E2E = import.meta.dirname;
const ROOT = resolve(E2E, '..', '..');

function usage(): string {
    return readFileSync(import.meta.filename, 'utf8').split('\n').slice(1, 11)
        .map((line) => line.replace(/^\/\/ ?/, '')).join('\n');
}

function executable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function modified(path: string): number {
    return statSync(path).mtimeMs;
}

let build = true, claude = 'fake', keep = false;
const prefixes: string[] = [];
for (const arg of process.argv.slice(2)) {
    if (arg === '--no-build') build = false;
    else if (arg === '--real-claude') claude = 'real';
    else if (arg === '--keep') keep = true;
    else if (arg === '-h' || arg === '--help') {
        console.log(usage());
        process.exit(0);
    } else prefixes.push(arg);
}

if (build) {
    console.log('Building Cue…');
    const built = spawnSync(join(ROOT, 'scripts', 'build.sh'), { stdio: ['inherit', 'ignore', 'inherit'] });
    if (built.status !== 0) {
        console.log('Build failed');
        process.exit(1);
    }
}
const app = join(ROOT, 'build', 'Cue.app');
if (!executable(join(app, 'Contents', 'MacOS', 'Cue'))) {
    console.log(`No ${app} — run without --no-build`);
    process.exit(1);
}
const fakeClaude = join(E2E, 'tools', 'fake-claude.ts');
if (claude === 'fake' && !executable(fakeClaude)) {
    console.log(`${fakeClaude} must be executable: Cue runs it as the claude CLI`);
    process.exit(1);
}

// One work folder per checkout, so worktrees running cases at once keep their own tools.
const checkout = createHash('sha1').update(`${ROOT}\n`).digest('hex').slice(0, 8);
const work = process.env['E2E_WORK'] || join(process.env['TMPDIR'] || tmpdir(), `cue-e2e-${checkout}`);
const bin = join(work, 'bin');
mkdirSync(bin, { recursive: true });
mkdirSync(join(work, 'cache'), { recursive: true });

// The helpers that need Apple's frameworks, rebuilt when their source changes.
for (const source of readdirSync(join(E2E, 'tools')).filter((name) => name.endsWith('.swift')).sort()) {
    const path = join(E2E, 'tools', source), tool = join(bin, basename(source, '.swift'));
    if (executable(tool) && modified(path) <= modified(tool)) continue;
    const compiled = spawnSync('swiftc', ['-O', '-o', tool, path], { encoding: 'utf8' });
    writeFileSync(`${tool}.log`, `${compiled.stdout ?? ''}${compiled.stderr ?? ''}`);
    if (compiled.status !== 0) {
        console.log(`Couldn't build ${source}:\n${compiled.stderr ?? compiled.error?.message ?? ''}`);
        process.exit(1);
    }
}

const cases = readdirSync(join(E2E, 'cases'))
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix)))
    .sort();
if (cases.length === 0) {
    console.log(`No cases match: ${prefixes.join(' ')}`);
    process.exit(1);
}

// What every case reads (see harness/config.ts).
Object.assign(process.env, { CUE_APP: app, E2E_WORK: work, E2E_CLAUDE: claude, E2E_KEEP: keep ? '1' : '0' });

// What this machine can do that the cases about to run depend on, probed once (harness/capabilities.ts):
// a case that needs what's missing skips with the reason.
const needs = new Set<'speech' | 'snapshots'>();
for (const name of cases) {
    const source = readFileSync(join(E2E, 'cases', name), 'utf8');
    if (/needWhisper\(/.test(source)) needs.add('speech');
    if (/snapshotText|dashboardPage|dashboardShows/.test(source)) needs.add('snapshots');
}
const capabilitiesFile = join(work, 'cache', 'capabilities.json');
const { probeMachine } = await import('./harness/capabilities.ts');
const capabilities = await probeMachine(needs, capabilitiesFile);
process.env['E2E_CAPABILITIES'] = capabilitiesFile;
const names = { speech: 'Speech recognition', windows: 'Window snapshots', overlay: 'Overlay snapshots' } as const;
for (const [name, found] of Object.entries(capabilities) as [keyof typeof names, { ok: boolean; detail: string }][]) {
    console.log(`${names[name]}: ${found.ok ? 'yes' : 'no'} — ${found.detail}`);
}

interface Outcome {
    output: string;
    failed: boolean;
    skip?: string;
}

const files = cases.map((name) => join(E2E, 'cases', name));
const outcomes = new Map<string, Outcome>(files.map((file) => [file, { output: '', failed: false }]));

/**
 * The case file an event is about. A case's own events name the file its test was declared in
 * (harness/case.ts) and, as `entryFile`, the case file the process ran; the events about the case
 * file as a whole name it as `file`.
 */
function caseFile(data: { file?: string; entryFile?: string }): string | undefined {
    const file = data.entryFile ?? data.file;
    return file === undefined ? undefined : resolve(file);
}

// Ctrl-C reaches the running case too: it cleans up and fails, no more cases run, and the report follows.
// A second Ctrl-C stops without waiting for the case.
const stop = new AbortController();
let stopping = false;
process.on('SIGINT', () => {
    if (stopping) stop.abort();
    stopping = true;
});

let passed = 0, failed = 0, skipped = 0;
const failures: string[] = [];
const column = (name: string): string => name.padEnd(32);

/** Each case's output, as it comes: E2E_WORK/NN-name.log. */
const logOf = (file: string): string => join(work, `${basename(file, '.test.ts')}.log`);

/** One line per case once it's done, with its output when it failed. */
function finish(file: string, seconds: number, outcome: Outcome): void {
    const name = basename(file, '.test.ts');
    if (outcome.output === '') {
        // A case says why it failed; one with nothing to say never got to run.
        if (outcome.failed) outcome.output = stopping ? 'not run: the run was stopped\n' : 'no output\n';
        writeFileSync(logOf(file), outcome.output);
    }
    if (outcome.failed) {
        failed++;
        failures.push(name);
        console.log(`  FAIL  ${column(name)} ${String(seconds).padStart(4)}s`);
        const tail = outcome.output.trimEnd().split('\n').slice(-25);
        console.log(tail.map((line) => `        ${line}`).join('\n'));
    } else if (outcome.skip !== undefined) {
        skipped++;
        console.log(`  SKIP  ${column(name)} ${outcome.skip}`);
    } else {
        passed++;
        console.log(`  PASS  ${column(name)} ${String(seconds).padStart(4)}s`);
    }
}

console.log(`Running ${cases.length} case(s), Claude: ${claude}`);
const done = new Set<string>();
for await (const event of run({ files, concurrency: 1, signal: stop.signal })) {
    if (event.type !== 'test:stdout' && event.type !== 'test:stderr' && event.type !== 'test:pass'
        && event.type !== 'test:fail' && event.type !== 'test:complete') continue;
    const file = caseFile(event.data);
    const outcome = file === undefined ? undefined : outcomes.get(file);
    if (file === undefined || outcome === undefined) continue;
    if (event.type === 'test:stdout' || event.type === 'test:stderr') {
        (outcome.output === '' ? writeFileSync : appendFileSync)(logOf(file), event.data.message);
        outcome.output += event.data.message;
        continue;
    }
    if (event.type === 'test:fail') outcome.failed = true;
    if (event.type === 'test:pass' && typeof event.data.skip === 'string') outcome.skip = event.data.skip;
    // node:test reports the case's test, then the file it ran in as a test of its own: the case is done.
    if (event.type === 'test:complete' && resolve(event.data.name) === file && !done.has(file)) {
        done.add(file);
        if (!event.data.details.passed) outcome.failed = true;
        finish(file, Math.round(event.data.details.duration_ms / 1000), outcome);
        if (stopping) stop.abort();
    }
}
// Cases the run stopped before node:test reported them.
for (const [file, outcome] of outcomes) {
    if (!done.has(file)) finish(file, 0, { ...outcome, failed: true });
}

console.log();
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped  (logs in ${work})`);
if (failed > 0) {
    console.log(`Failed: ${failures.join(' ')}`);
    process.exit(1);
}
