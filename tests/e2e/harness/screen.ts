// Reading rendered windows: Cue's snapshots and --render output are images, read with macOS Vision, or Tesseract where Vision's
// accurate recognizer can't run (harness/tesseract.ts), and with Windows' own OCR on Windows.
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_BIN, E2E_ROOT, IS_WINDOWS } from './config.ts';
import { exec, type Ran } from './process.ts';
import { fail, print } from './results.ts';
import { type ReadLine, readLines } from './tesseract.ts';

/** Whether Vision reads this Mac's images: tools/ocr.swift exits with 3 where its accurate recognizer can't run, and Tesseract reads from then on. */
let vision = true;

/** Runs tools/ocr.swift on an image (tools/ocr.ps1 on Windows, which can read one area of it alone). */
export async function readImage(png: string, area?: Area): Promise<Ran> {
    if (!IS_WINDOWS) {
        if (area) return fail('reading one area of an image is for Windows');
        if (vision) {
            const read = await exec(join(E2E_BIN, 'ocr'), [png]);
            if (read.code !== 3) return read;
            vision = false;
        }
        return readWithTesseract(png);
    }
    // Windows' OCR holds the file while it reads, and Cue replaces its snapshot every 2 s: read a copy.
    const copy = `${png}.ocr.png`;
    copyFileSync(png, copy);
    return powershell('ocr.ps1', copy, ...(area ? [area.left, area.top, area.width, area.height].map(String) : []));
}

/** Who reads this Mac's images, once one has been read: for the capability probe's report. */
export function imageReader(): string {
    return vision ? 'Vision' : 'Tesseract (Vision’s accurate recognizer can’t run here)';
}

/**
 * As tools/ocr.swift reads with Vision: the image over white and over black (inverted, so its light text is dark too), top to bottom and
 * left to right. Where the two read the same line (their boxes mostly the same), the surer reading: Tesseract reads a line a little
 * differently in each ("Participant 2 » Olena" and "Participant 2 = Olena"). Lines that only touch, as a button floating over a list, both stay.
 */
async function readWithTesseract(png: string): Promise<Ran> {
    const [light, dark] = [`${png}.light.png`, `${png}.dark.png`];
    const prepared = await exec(join(E2E_BIN, 'ocr'), ['--prepare', png, light, dark]);
    if (prepared.code !== 0) return prepared;
    const [onLight = [], onDark = []] = await readLines(light, dark);
    const area = (line: ReadLine): number => (line.right - line.left) * (line.bottom - line.top);
    const same = (a: ReadLine, b: ReadLine): boolean => {
        const shared =
            Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
            Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        return shared >= (area(a) + area(b) - shared) / 2;
    };
    const lines: ReadLine[] = [];
    for (const line of [...onLight, ...onDark].sort((a, b) => b.confidence - a.confidence)) {
        if (!lines.some((kept) => same(kept, line))) lines.push(line);
    }
    lines.sort((a, b) => {
        // Lines whose middles are within half a line of each other are one row.
        const [middleA, middleB] = [(a.top + a.bottom) / 2, (b.top + b.bottom) / 2];
        const row = Math.min(a.bottom - a.top, b.bottom - b.top) / 2;
        return Math.abs(middleA - middleB) > row ? middleA - middleB : a.left - b.left;
    });
    const stdout = lines.map((line) => `${line.text}\n`).join('');
    return { code: 0, stdout, stderr: '', output: stdout };
}

/** A rectangle in an image's or the screen's own pixels. */
export interface Area {
    left: number;
    top: number;
    width: number;
    height: number;
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

/** A control of a window as UI Automation lays it out (see `controlsOf`). */
export interface Control {
    name: string;
    /** UI Automation's control type: `Button`, `Text`, … */
    type: string;
    /** In the screen's own pixels. */
    left: number;
    top: number;
    width: number;
    height: number;
}

/** Where the named controls of the program's window with this title are (tools/uia-bounds.ps1), in the order the tree has them. */
export async function controlsOf(pid: number, title: string): Promise<Control[]> {
    const read = await powershell('uia-bounds.ps1', String(pid), title);
    if (read.code !== 0) fail(`uia-bounds.ps1 ${pid} failed`, read.output);
    return JSON.parse(read.stdout) as Control[];
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
export async function captureScreen(area: Area, out: string): Promise<void> {
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

/** The text Vision reads in an image, one line per text block, top to bottom; on Windows, with `area`, only the words in that part of it. */
export async function ocr(png: string, area?: Area): Promise<string> {
    const read = await readImage(png, area);
    if (read.stderr) print(read.stderr);
    return read.stdout;
}
