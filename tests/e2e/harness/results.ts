// How a case ends early: it fails (with what it saw), or it skips because the machine lacks something.
import assert from 'node:assert/strict';

/** Writes text to the case's output (its log, and the runner's report when it fails). */
export function print(...texts: string[]): void {
    for (const text of texts) process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Fails the case with `message`, printing `dumps` first (a file's contents, a tool's output). */
export function fail(message: string, ...dumps: string[]): never {
    print(...dumps);
    assert.fail(message);
}

/** Thrown by `skip`; the case wrapper turns it into node:test's skip. */
export class Skip extends Error {
    override name = 'Skip';
}

/** Skips the case: something it needs is missing here (a model, a voice, the network). */
export function skip(reason: string): never {
    throw new Skip(reason);
}
