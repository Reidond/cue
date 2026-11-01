// Declares a case: one node:test test that gets a fresh sandboxed Cue and always cleans up after it.
import { AssertionError } from 'node:assert';
import { constants } from 'node:os';
import { basename } from 'node:path';
import { test } from 'node:test';
import { Cue } from './sandbox.ts';
import { print, Skip } from './results.ts';

function describe(error: unknown): string {
    if (error instanceof AssertionError) return error.message;
    return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

/**
 * A case, in tests/e2e/cases/NN-name.test.ts: `title` says the user-visible behaviour it checks,
 * `body` checks it with the sandbox's `cue`. A failed check fails it, `skip` (or a `need…`) skips it;
 * either way Cue is stopped and its settings are removed, and a failed case keeps its sandbox.
 */
export function e2eCase(title: string, body: (cue: Cue) => Promise<void>): void {
    void test(title, async (t) => {
        const cue = await Cue.open(basename(t.filePath ?? process.argv[1] ?? 'case', '.test.ts'));
        // Interrupted (Ctrl-C, or the runner stopping): clean up as a failed case would, then go.
        const interrupted = (signal: NodeJS.Signals): void => {
            print(`FAIL: interrupted (${signal})`);
            void cue.close(false).finally(() => process.exit(128 + constants.signals[signal]));
        };
        process.once('SIGINT', interrupted);
        process.once('SIGTERM', interrupted);
        let succeeded = false;
        try {
            await body(cue);
            succeeded = true;
        } catch (error) {
            if (!(error instanceof Skip)) {
                print(`FAIL: ${describe(error)}`);
                throw error;
            }
            print(`SKIP: ${error.message}`);
            t.skip(error.message);
            succeeded = true;
        } finally {
            await cue.close(succeeded);
            process.off('SIGINT', interrupted);
            process.off('SIGTERM', interrupted);
        }
    });
}
