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
    windows: {
        title: string;
        width: number;
        height: number;
        left: number;
        top: number;
        toolWindow: boolean;
        noActivate: boolean;
        /** Above every normal window (WS_EX_TOPMOST). */
        topmost: boolean;
        /** SetWindowDisplayAffinity: 0 drawn normally, 0x11 hidden from screenshots and screen sharing. */
        affinity: number;
        inFront: number;
    }[];
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

/**
 * Presses a control of the program's windows by its name through UI Automation (tools/uia-click.ps1), as a click would: a button is invoked, a toggle
 * toggled; with `text` a text box gets that text. Fails the case when nothing in the program has that name.
 */
export async function press(pid: number, name: string, text?: string): Promise<void> {
    const ran = await powershell('uia-click.ps1', String(pid), name, ...(text === undefined ? [] : [text]));
    if (ran.stdout.trim() !== 'ok') fail(`nothing named "${name}" to press in the program's windows`, ran.output);
}

/**
 * Expands the Expander with this name in the program's windows (Advanced on a project's Overview) through UI Automation's expand pattern, as
 * Narrator does: a WinUI Expander's header is no button of its own to press (`press` invokes or toggles). Fails the case when nothing has the name.
 */
export async function expand(pid: number, name: string): Promise<void> {
    const script = [
        'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
        '$auto = [System.Windows.Automation.AutomationElement]',
        `$mine = New-Object System.Windows.Automation.PropertyCondition($auto::ProcessIdProperty, ${pid})`,
        `$named = New-Object System.Windows.Automation.PropertyCondition($auto::NameProperty, '${name.replaceAll("'", "''")}')`,
        'foreach ($window in $auto::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $mine)) {',
        '    foreach ($element in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $named)) {',
        '        $pattern = $null',
        '        if ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {',
        '            $pattern.Expand()',
        "            'ok'",
        '            exit 0',
        '        }',
        '    }',
        '}',
        "'missing'",
    ].join('\n');
    const ran = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (ran.stdout.trim() !== 'ok') fail(`nothing named "${name}" to expand in the program's windows`, ran.output);
}

/**
 * A real click on a control of the program's windows, found by its name through UI Automation (tools/uia-click.ps1 -Mouse): the pointer moves to its
 * middle and the left button goes down and up. A window that must not take the focus has its chance to here, which `press` (an invocation) never gives it.
 */
export async function click(pid: number, name: string): Promise<void> {
    const ran = await powershell('uia-click.ps1', String(pid), name, '-Mouse');
    if (ran.stdout.trim() !== 'ok') fail(`nothing named "${name}" to click in the program's windows`, ran.output);
}

/**
 * A real click on a button of the notification (toast) Windows is showing (tools/toast.ps1: UI Automation cannot see the shell's toast, so it is found by
 * reading the corner of the screen). True when the button was there and was clicked; the banner is up for about five seconds, so ask again.
 */
export async function clickToast(button: string): Promise<boolean> {
    const ran = await powershell('toast.ps1', button);
    if (ran.code !== 0) fail('toast.ps1 failed', ran.output);
    return ran.stdout.trim() === 'ok';
}

/** Types letters, digits and spaces on the keyboard, one after another, into whatever has the focus (tools/keys.ps1). */
export async function typeText(text: string): Promise<void> {
    const ran = await powershell('keys.ps1', 'type', text);
    if (ran.code !== 0) fail('keys.ps1 failed', ran.output);
}

/** A picture of part of the screen as a screenshot or a screen share would show it (tools/capture.ps1), at the screen's own pixels. */
export async function captureScreen(area: { left: number; top: number; width: number; height: number }, out: string): Promise<void> {
    const ran = await powershell('capture.ps1', ...[area.left, area.top, area.width, area.height].map(String), out);
    if (ran.code !== 0) fail('capture.ps1 failed', ran.output);
}

/** Presses a chord on the keyboard as a person would (tools/keys.ps1): `pressKeys('win', 'alt', 'enter')`. */
export async function pressKeys(...keys: string[]): Promise<void> {
    const ran = await powershell('keys.ps1', ...keys);
    if (ran.code !== 0) fail('keys.ps1 failed', ran.output);
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
