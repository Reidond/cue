// What a case may need that a machine can lack. Each one skips the case, with the reason, when it's
// missing: nothing here fakes it.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEEPGRAM, E2E_ROOT, KEYCHAIN_ITEMS } from './config.ts';
import { literal } from './files.ts';
import { exec } from './process.ts';
import { skip } from './results.ts';
import { windowsOf } from './screen.ts';
import { sleep } from './time.ts';

/** What the runner found this machine can do (see capabilities.ts), read once per case. */
export interface Capability {
    ok: boolean;
    /** How it went: the timing, the capture method, or why it can't. */
    detail: string;
}

export type Capabilities = Partial<Record<'windows' | 'overlay', Capability>>;

let found: Capabilities | undefined;

/** A capability the runner probed; undefined when it didn't (no case it runs needs it). */
function probed(name: keyof Capabilities): Capability | undefined {
    const file = process.env['E2E_CAPABILITIES'];
    if (!file) return undefined;
    found ??= JSON.parse(readFileSync(file, 'utf8')) as Capabilities;
    return found[name];
}

/** Snapshots of Cue's windows (CUE_SNAPSHOT: the dashboard, Settings) that Vision can read here. */
export function needWindowSnapshots(): void {
    const windows = probed('windows');
    if (windows && !windows.ok) skip(windows.detail);
}

/** On Windows: Windows' own OCR (Windows.Media.Ocr) has a recognizer, which the cases that read the app's snapshots need; `setup.ps1` adds the English one. */
export async function needWindowsOcr(): Promise<void> {
    const ran = await exec('powershell.exe', [
        '-NoProfile',
        '-Command',
        "$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]; if ([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages.Count -gt 0) { 'yes' }",
    ]);
    if (ran.stdout.trim() !== 'yes')
        skip("Windows has no OCR language installed (setup.ps1 adds the English one), so the app's snapshots can't be read");
}

/**
 * On Windows: a desktop that gives a window the keyboard focus, as a person's does: the cases that press keys, click and watch where the focus is need one.
 * Some CI sessions have none (a window shown there never becomes the foreground one, and injected keys go nowhere), so the check is made, by showing a
 * window of another program (tools/blocker.ps1) and looking whether it gets the focus; the case skips when it does not.
 */
export async function needInteractiveDesktop(): Promise<void> {
    if (process.platform !== 'win32') skip('this case is about Windows');
    const blocker = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(E2E_ROOT, 'tools', 'blocker.ps1')], {
        stdio: 'ignore',
    });
    try {
        for (let waited = 0; waited < 30; waited++) {
            if (blocker.pid !== undefined && (await windowsOf(blocker.pid).catch(() => undefined))?.foreground) return;
            await sleep(1);
        }
        skip(
            "this session has no desktop that gives a window the keyboard focus (some CI runners' sessions don't), so the focus and the keys can't be tried",
        );
    } finally {
        blocker.kill();
    }
}

/** On Windows: whether there is a sound device to play through and listen to the PC play (a CI runner has none; a VM has a virtual one). */
export async function hasAudioOutput(): Promise<boolean> {
    const ran = await exec('powershell.exe', [
        '-NoProfile',
        '-Command',
        "if (@(Get-CimInstance Win32_SoundDevice | Where-Object { $_.Status -eq 'OK' }).Count -gt 0) { 'yes' }",
    ]);
    return ran.stdout.trim() === 'yes';
}

/** On Windows: a sound device to play through and listen to the PC play (a CI runner has none; a VM has a virtual one), for the cases that let Cue hear real audio. */
export async function needAudioOutput(): Promise<void> {
    if (!(await hasAudioOutput())) skip('this PC has no sound device to play through and listen to (a CI runner has none)');
}

/** A snapshot of the overlay that Vision can read here (it is drawn differently: it is all glass). */
export function needOverlaySnapshots(): void {
    const overlay = probed('overlay');
    if (overlay && !overlay.ok) skip(overlay.detail);
}

/**
 * A key for a real service, from the login keychain (KEYCHAIN_ITEMS); skips without one. Never print it:
 * the harness writes it only into the sandbox's key store, which goes when the case ends.
 */
export async function keychainKey(service: keyof typeof KEYCHAIN_ITEMS): Promise<string> {
    const found = await exec('security', ['find-generic-password', '-s', KEYCHAIN_ITEMS[service], '-w']);
    const key = found.stdout.trim();
    if (found.code !== 0 || key === '') skip(`no "${KEYCHAIN_ITEMS[service]}" in the login keychain (see AGENTS.md › Testing)`);
    return key;
}

/** The real Deepgram behind the backend (`run.ts --real-deepgram`), with its key in the keychain. */
export async function needRealDeepgram(): Promise<void> {
    if (DEEPGRAM !== 'real') skip('needs --real-deepgram');
    await keychainKey('deepgram');
}

/**
 * An elevated process (Run as administrator; a CI runner is one): Windows Installer installs per machine only for one. Skips the case without it,
 * as it can't ask: a prompt nobody answers would hold the run.
 */
export async function needElevation(): Promise<void> {
    if (process.platform !== 'win32') skip('installing Cue is for Windows');
    // `net session` needs administrator rights.
    if ((await exec('net', ['session'])).code !== 0)
        skip('needs an elevated PowerShell (Run as administrator): the installer is per machine');
}

let voices: Promise<string[]> | undefined;

/** A macOS voice, for `say`. */
export async function needVoice(voice: string): Promise<void> {
    voices ??= exec('say', ['-v', '?']).then((ran) => ran.stdout.split('\n'));
    const listed = new RegExp(`^${literal(voice)}( |\\()`);
    if (!(await voices).some((line) => listed.test(line))) skip(`voice '${voice}' is not installed`);
}

/** A server on the network: any answer will do, within 10 seconds. */
export async function needReachable(url: string, name: string): Promise<void> {
    try {
        await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    } catch {
        skip(`${name} can't be reached`);
    }
}
