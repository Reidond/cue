// What the runner (run.ts) tells every case through the environment, and the paths that follow from it.
import { homedir } from 'node:os';
import { join } from 'node:path';

function fromRunner(name: string): string {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is not set: run cases through tests/e2e/run.ts`);
    return value;
}

/** tests/e2e */
export const E2E_ROOT = join(import.meta.dirname, '..');
export const FIXTURES = join(E2E_ROOT, 'fixtures');
/** The stand-in for the `claude` CLI (see tools/fake-claude.ts). */
export const FAKE_CLAUDE = join(E2E_ROOT, 'tools', 'fake-claude.ts');

export const CUE_APP = fromRunner('CUE_APP');
export const CUE_BIN = join(CUE_APP, 'Contents', 'MacOS', 'Cue');
/** One work folder per checkout: sandboxes, case logs, the compiled tools and caches. */
export const E2E_WORK = fromRunner('E2E_WORK');
export const E2E_BIN = join(E2E_WORK, 'bin');
export const E2E_CACHE = join(E2E_WORK, 'cache');

/** Which `claude` Cue talks to: the stand-in, or the real CLI (`run.ts --real-claude`). */
export const CLAUDE: 'fake' | 'real' = process.env['E2E_CLAUDE'] === 'real' ? 'real' : 'fake';
/** Which Anthropic API Cue talks to: the stand-in (harness/fake-providers.ts), or the real one (`--real-anthropic`). */
export const ANTHROPIC: 'fake' | 'real' = process.env['E2E_ANTHROPIC'] === 'real' ? 'real' : 'fake';
/** Which Deepgram Cue talks to: the stand-in, or the real one (`--real-deepgram`). */
export const DEEPGRAM: 'fake' | 'real' = process.env['E2E_DEEPGRAM'] === 'real' ? 'real' : 'fake';
/**
 * Where the real services' keys are, for `--real-anthropic` and `--real-deepgram`: generic passwords in the
 * login keychain, which the harness reads with `security` and hands only to the sandboxed Cue.
 */
export const KEYCHAIN_ITEMS = { anthropic: 'Cue e2e Anthropic API key', deepgram: 'Cue e2e Deepgram API key' } as const;
/** `run.ts --keep`: keep every case's sandbox, not only the failed ones. */
export const KEEP = process.env['E2E_KEEP'] === '1';

/** The user's real Cue folder: only its models are used, linked into each sandbox, never changed. */
export const REAL_SUPPORT = join(homedir(), 'Library', 'Application Support', 'Cue');

/** fixtures/… */
export function fixture(...parts: string[]): string {
    return join(FIXTURES, ...parts);
}
