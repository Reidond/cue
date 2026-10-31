// Assertions on what Cue left on disk. Patterns match line by line and ignore case, as `grep -i -E` did;
// a failed one prints what it looked at and fails the case.
import { basename } from 'node:path';
import { lines, nonEmpty, readText, withFlags } from './files.ts';
import { fail } from './results.ts';

function matchingLines(file: string, pattern: RegExp): Array<{ number: number; line: string }> {
    const regex = withFlags(pattern, 'i');
    return lines(file).flatMap((line, index) => (regex.test(line) ? [{ number: index + 1, line }] : []));
}

/** The file exists and isn't empty. */
export function assertFile(file: string, message?: string): void {
    if (!nonEmpty(file)) fail(message ?? `expected a non-empty file at ${file}`);
}

/** Some line of the file matches. */
export function assertContains(file: string, pattern: RegExp, message?: string): void {
    if (matchingLines(file, pattern).length > 0) return;
    const text = readText(file);
    const head = text === undefined ? `(can't read ${file})` : Buffer.from(text).subarray(0, 6000).toString();
    fail(message ?? `${basename(file)} should match /${pattern.source}/`, `--- ${file}`, head);
}

/** No line of the file matches (a file that doesn't exist has none). */
export function assertNotContains(file: string, pattern: RegExp, message?: string): void {
    const found = matchingLines(file, pattern);
    if (found.length === 0) return;
    const shown = found
        .slice(0, 20)
        .map(({ number, line }) => `${number}:${line}`)
        .join('\n');
    fail(message ?? `${basename(file)} should not match /${pattern.source}/`, `--- matches in ${file}`, shown);
}

export function assertEq<T extends string | number | boolean | undefined>(actual: T, expected: T, message?: string): void {
    if (actual !== expected) fail(message ?? `expected '${expected}', got '${actual}'`);
}

/** low ≤ value ≤ high; a value that couldn't be measured fails. */
export function assertBetween(value: number | undefined, low: number, high: number, message?: string): void {
    if (value === undefined || Number.isNaN(value) || value < low || value > high) {
        fail(message ?? `expected ${value ?? ''} to be between ${low} and ${high}`);
    }
}
