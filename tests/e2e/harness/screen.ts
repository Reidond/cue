// Reading rendered windows: Cue's snapshots and --render output are images, read with macOS Vision (Windows' own OCR on Windows).
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_BIN, E2E_ROOT, IS_WINDOWS } from './config.ts';
import { exec, type Ran } from './process.ts';
import { fail, print } from './results.ts';

/** Runs tools/ocr.swift on an image (tools/ocr.ps1 on Windows). */
export async function readImage(png: string): Promise<Ran> {
    if (!IS_WINDOWS) return exec(join(E2E_BIN, 'ocr'), [png]);
    // Windows' OCR holds the file while it reads, and Cue replaces its snapshot every 2 s: read a copy.
    const copy = `${png}.ocr.png`;
    copyFileSync(png, copy);
    return powershell('ocr.ps1', copy);
}

/** Runs one of the PowerShell tools in tests/e2e/tools. */
function powershell(tool: string, ...args: string[]): Promise<Ran> {
    return exec('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(E2E_ROOT, 'tools', tool), ...args]);
}

/** What a person sees of Cue's windows on Windows right now (see tools/windows.ps1). */
export interface WindowsOfApp {
    /** Whether one of its windows has the keyboard focus. */
    foreground: boolean;
    /** Its visible windows, front to back. */
    windows: { title: string; width: number; height: number; toolWindow: boolean; noActivate: boolean; inFront: number }[];
}

/**
 * The text of the program's windows as UI Automation has it (tools/uia.ps1), one line per element: exact (no recognition errors), complete (what is
 * scrolled out of view too).
 */
export async function windowText(pid: number): Promise<string> {
    const read = await powershell('uia.ps1', String(pid));
    if (read.code !== 0) fail(`uia.ps1 ${pid} failed`, read.output);
    return read.stdout.replaceAll('\r\n', '\n');
}

/** Runs tools/windows.ps1 for the program with this process ID. */
export async function windowsOf(pid: number): Promise<WindowsOfApp> {
    const read = await powershell('windows.ps1', String(pid));
    if (read.code !== 0) fail(`windows.ps1 ${pid} failed`, read.output);
    return JSON.parse(read.stdout) as WindowsOfApp;
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
