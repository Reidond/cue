// What a case may need that a machine can lack. Each one skips the case, with the reason, when it's
// missing: nothing here fakes it.
import { accessSync, constants } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE, REAL_SUPPORT } from './config.ts';
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

/** The speech model and whisper-server, for live recognition. */
export function needWhisper(): void {
    if (!exists(join(REAL_SUPPORT, 'models', 'ggml-large-v3-turbo.bin'))) skip('speech model not downloaded');
    if (!brewBins.some((bin) => executable(join(bin, 'whisper-server')))) skip('whisper-server not installed');
}

/** The second pass's whisper-cli; returns its path. */
export function needWhisperCli(): string {
    const found = brewBins.map((bin) => join(bin, 'whisper-cli')).find(exists);
    if (found === undefined || !executable(found)) skip('whisper-cli not installed');
    return found;
}

/** The real `claude` CLI (`run.ts --real-claude`). */
export function needRealClaude(): void {
    if (CLAUDE !== 'real') skip('needs --real-claude');
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
