// Reading what Cue left on disk, the way the Bash cases did with grep, find and ls. These only read
// small files, so they are synchronous: an assertion built on them can't be left un-awaited.
import { chmod, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The file's text, or undefined when it can't be read (missing, a folder). */
export function readText(file: string): string | undefined {
    try {
        return readFileSync(file, 'utf8');
    } catch {
        return undefined;
    }
}

/** A text split into lines as grep sees them (no empty line after the final newline). */
export function linesOf(text: string): string[] {
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines;
}

/** The file's lines; none when it can't be read. */
export function lines(file: string): string[] {
    const text = readText(file);
    return text === undefined ? [] : linesOf(text);
}

/** `text` as a pattern that matches only itself, to build a RegExp around a path or a name. */
export function literal(text: string): string {
    return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

/** The pattern with `add` among its flags and without the stateful g / y. */
export function withFlags(pattern: RegExp, add = ''): RegExp {
    const flags = new Set([...pattern.flags.replace(/[gy]/g, ''), ...add]);
    return new RegExp(pattern.source, [...flags].join(''));
}

/** How many of the file's lines match (`grep -c`), with the pattern as written. */
export function countLines(file: string, pattern: RegExp): number {
    const regex = withFlags(pattern);
    return lines(file).filter((line) => regex.test(line)).length;
}

/** Every match in the file, line by line, in order (`grep -o`). */
export function matches(file: string, pattern: RegExp): string[] {
    const regex = withFlags(pattern, 'g');
    return lines(file).flatMap((line) => [...line.matchAll(regex)].map((match) => match[0]));
}

/** The file's last `count` lines (`tail -n`). */
export function tail(file: string, count: number): string {
    return lines(file).slice(-count).join('\n');
}

/** A file (or folder) that exists and isn't empty (`test -s`). */
export function nonEmpty(path: string): boolean {
    try {
        return statSync(path).size > 0;
    } catch {
        return false;
    }
}

export function exists(path: string): boolean {
    try {
        statSync(path);
        return true;
    } catch {
        return false;
    }
}

/** A regular file that exists (`test -f`). */
export function isFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

export function isDirectory(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}

/** A folder's visible entries, sorted (`ls`); none when it doesn't exist. */
export function listDir(dir: string): string[] {
    try {
        return readdirSync(dir).filter((name) => !name.startsWith('.')).sort();
    } catch {
        return [];
    }
}

/** Every file and folder under `dir` whose name matches, not following links (`find DIR -name`), sorted. */
export function findFiles(dir: string, name: RegExp, exclude?: RegExp): string[] {
    const found: string[] = [];
    const walk = (folder: string): void => {
        let entries;
        try {
            entries = readdirSync(folder, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const path = join(folder, entry.name);
            if (name.test(entry.name) && !exclude?.test(path)) found.push(path);
            if (entry.isDirectory()) walk(path);
        }
    };
    walk(dir);
    return found.sort();
}

/** Two paths to the same file (`test -ef`). */
export function sameFile(a: string, b: string): boolean {
    try {
        const first = statSync(a), second = statSync(b);
        return first.dev === second.dev && first.ino === second.ino;
    } catch {
        return false;
    }
}

/** Two files with the same bytes (`cmp -s`). */
export function sameContents(a: string, b: string): boolean {
    try {
        return readFileSync(a).equals(readFileSync(b));
    } catch {
        return false;
    }
}

/** Writes a script and makes it executable. */
export async function writeExecutable(path: string, text: string): Promise<string> {
    await writeFile(path, text);
    await chmod(path, 0o755);
    return path;
}
