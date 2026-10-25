// Reading rendered windows: Cue's snapshots and --render output are images, read with macOS Vision.
import { join } from 'node:path';
import { E2E_BIN } from './config.ts';
import { exec, type Ran } from './process.ts';
import { print } from './results.ts';

/** Runs tools/ocr.swift on an image. */
export function readImage(png: string): Promise<Ran> {
    return exec(join(E2E_BIN, 'ocr'), [png]);
}

/** The text Vision reads in an image, one line per text block, top to bottom. */
export async function ocr(png: string): Promise<string> {
    const read = await readImage(png);
    if (read.stderr) print(read.stderr);
    return read.stdout;
}
