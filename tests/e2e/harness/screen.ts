// Reading rendered windows: Cue's snapshots and --render output are images, read with macOS Vision.
import { join } from 'node:path';
import { E2E_BIN } from './config.ts';
import { exec, type Ran } from './process.ts';
import { fail, print } from './results.ts';

/** Runs tools/ocr.swift on an image. */
export function readImage(png: string): Promise<Ran> {
    return exec(join(E2E_BIN, 'ocr'), [png]);
}

/** What the user sees of an app right now (see tools/windows.swift). */
export interface AppWindows {
    /** Whether it is the active app, the one with keyboard focus. */
    active: boolean;
    /** The active app. */
    frontmost: { pid: number; name: string } | null;
    /** `regular` has a Dock icon; `accessory` doesn't; `not running` once it quit. */
    policy: 'regular' | 'accessory' | 'prohibited' | 'not running';
    /** Its windows on screen, front to back, with their window levels. */
    windows: { level: number; width: number; height: number }[];
    /** The desktop picture's, the desktop icons' and normal windows' levels. */
    levels: { desktop: number; desktopIcons: number; normal: number };
}

/** Runs tools/windows.swift for the app with this process ID. */
export async function appWindows(pid: number): Promise<AppWindows> {
    const read = await exec(join(E2E_BIN, 'windows'), [String(pid)]);
    if (read.code !== 0) fail(`windows ${pid} failed`, read.output);
    return JSON.parse(read.stdout) as AppWindows;
}

/** The text Vision reads in an image, one line per text block, top to bottom. */
export async function ocr(png: string): Promise<string> {
    const read = await readImage(png);
    if (read.stderr) print(read.stderr);
    return read.stdout;
}
