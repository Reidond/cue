// What a case may need that a machine can lack. Each one skips the case, with the reason, when it's
// missing: nothing here fakes it.
import { accessSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEEPGRAM, KEYCHAIN_ITEMS, REAL_SUPPORT } from './config.ts';
import { exists, literal } from './files.ts';
import { exec } from './process.ts';
import { skip } from './results.ts';

const brewBins = ['/opt/homebrew/bin', '/usr/local/bin'];

function executable(path: string): boolean {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

/** What the runner found this machine can do (see capabilities.ts), read once per case. */
export interface Capability {
    ok: boolean;
    /** How it went: the timing, the capture method, or why it can't. */
    detail: string;
}

export type Capabilities = Partial<Record<'speech' | 'windows' | 'overlay', Capability>>;

let found: Capabilities | undefined;

/** A capability the runner probed; undefined when it didn't (no case it runs needs it). */
function probed(name: keyof Capabilities): Capability | undefined {
    const file = process.env['E2E_CAPABILITIES'];
    if (!file) return undefined;
    found ??= JSON.parse(readFileSync(file, 'utf8')) as Capabilities;
    return found[name];
}

/** The second pass's speech model and whisper-cli, and speech recognition fast enough for the cases' timeouts (the live transcript is the backend's: no case needs this for it). */
export function needWhisper(): void {
    if (!exists(join(REAL_SUPPORT, 'models', 'ggml-large-v3-turbo.bin'))) skip('speech model not downloaded');
    needWhisperCli();
    const speech = probed('speech');
    if (speech && !speech.ok) skip(speech.detail);
}

/** Snapshots of Cue's windows (CUE_SNAPSHOT: the dashboard, Settings) that Vision can read here. */
export function needWindowSnapshots(): void {
    const windows = probed('windows');
    if (windows && !windows.ok) skip(windows.detail);
}

/** A snapshot of the overlay that Vision can read here (it is drawn differently: it is all glass). */
export function needOverlaySnapshots(): void {
    const overlay = probed('overlay');
    if (overlay && !overlay.ok) skip(overlay.detail);
}

/** The second pass's whisper-cli; returns its path. */
export function needWhisperCli(): string {
    const found = brewBins.map((bin) => join(bin, 'whisper-cli')).find(exists);
    if (found === undefined || !executable(found)) skip('whisper-cli not installed');
    return found;
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
