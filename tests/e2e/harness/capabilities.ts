// What some cases depend on and some Macs can't do: recognize speech fast enough for the cases'
// timeouts, and draw window snapshots that Vision can read. GitHub's macOS runners, for one, have
// no GPU for whisper.cpp and composite no windows offscreen. The runner (run.ts) probes each once
// per run, before the cases, and a case that depends on one skips with the measured reason
// (requirements.ts) instead of timing out.
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { E2E_WORK, REAL_SUPPORT } from './config.ts';
import { exists, linesOf, nonEmpty, readText } from './files.ts';
import { exec } from './process.ts';
import type { Capabilities, Capability } from './requirements.ts';
import { Cue } from './sandbox.ts';
import { ocr } from './screen.ts';
import { sleep } from './time.ts';

/** Seconds whisper-cli may take for the test phrase; about 3 s on an M2 Pro, model loading included. */
const SPEECH_LIMIT = 20;
const PHRASE = 'The report is due on Friday.';

/** Seconds of 16 kHz mono 16-bit audio in a WAV file. */
async function wavSeconds(path: string): Promise<number> {
    return ((await stat(path)).size - 44) / 32_000;
}

function lastLine(text: string): string {
    return linesOf(text).filter((line) => line.trim() !== '').at(-1) ?? '';
}

/** Whether whisper-cli hears a short spoken phrase, and how long it takes. */
export async function probeSpeech(): Promise<Capability | undefined> {
    const model = join(REAL_SUPPORT, 'models', 'ggml-large-v3-turbo.bin');
    const cli = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'].find(exists);
    // Without them the cases skip on their own (needWhisper, needWhisperCli).
    if (!exists(model) || cli === undefined) return undefined;
    const dir = await mkdtemp(join(E2E_WORK, 'probe-speech.'));
    try {
        const aiff = join(dir, 'phrase.aiff'), wav = join(dir, 'phrase.wav');
        // An English voice (the default one speaks the system's language); any voice if it's missing.
        let said = await exec('say', ['-v', 'Samantha', '-o', aiff, '--', PHRASE]);
        if (said.code !== 0) said = await exec('say', ['-o', aiff, '--', PHRASE]);
        const converted = said.code === 0 ? await exec('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]) : said;
        if (converted.code !== 0) return { ok: false, detail: `couldn't make test speech with say: ${lastLine(converted.output)}` };
        const length = (await wavSeconds(wav)).toFixed(1);
        const started = Date.now();
        const heard = await exec(cli, ['-m', model, '-f', wav, '-l', 'en', '-nt', '-np'], { timeout: SPEECH_LIMIT * 3 });
        const took = ((Date.now() - started) / 1000).toFixed(1);
        const slow = `speech recognition is too slow here: ${length} s of speech took`;
        if (heard.code === 137) return { ok: false, detail: `${slow} over ${SPEECH_LIMIT * 3} s (the cases need it within ${SPEECH_LIMIT} s)` };
        if (heard.code !== 0) return { ok: false, detail: `whisper-cli fails here (exit ${heard.code}): ${lastLine(heard.stderr)}` };
        if (!/friday/i.test(heard.stdout)) {
            return { ok: false, detail: `whisper-cli doesn't hear test speech here (it heard "${heard.stdout.trim().slice(0, 80)}")` };
        }
        if (Number(took) > SPEECH_LIMIT) return { ok: false, detail: `${slow} ${took} s (the cases need it within ${SPEECH_LIMIT} s)` };
        return { ok: true, detail: `${took} s for ${length} s of speech` };
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
}

/** Whether Cue's snapshots of its dashboard and overlay read as text. */
export async function probeSnapshots(): Promise<Capability> {
    const cue = await Cue.open('00-probe-snapshots');
    let readable = false, dashboard = '', overlay = '';
    try {
        await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png') });
        // The dashboard opens at launch, on Home; the overlay is drawn even while it is hidden.
        for (const deadline = Date.now() + 30_000; Date.now() < deadline && !readable; await sleep(2)) {
            if (nonEmpty(cue.path('cue-dashboard.png'))) dashboard = await ocr(cue.path('cue-dashboard.png'));
            if (nonEmpty(cue.path('cue.png'))) overlay = await ocr(cue.path('cue.png'));
            readable = /New Project/i.test(dashboard) && /Listening|No audio|When someone asks|Drop your|Ask anything/i.test(overlay);
        }
        const method = linesOf(readText(cue.sessionLog()) ?? '').map((line) => /📸 Snapshots: (.*)/.exec(line)?.[1]).find(Boolean)
            ?? 'capture method not logged';
        if (readable) return { ok: true, detail: method };
        const blank = [dashboard.trim() ? '' : 'the dashboard', overlay.trim() ? '' : 'the overlay'].filter(Boolean);
        const what = blank.length > 0 ? `no text in ${blank.join(' or ')}` : 'not the expected text';
        return { ok: false, detail: `window snapshots aren't readable here (${what}; ${method})` };
    } finally {
        await cue.close(readable);
    }
}

/**
 * Probes what the cases about to run need, writes the results where requirements.ts reads them
 * (the file E2E_CAPABILITIES names) and returns them.
 */
export async function probeMachine(needs: ReadonlySet<keyof Capabilities>, file: string): Promise<Capabilities> {
    const found: Capabilities = {};
    if (needs.has('speech')) {
        const speech = await probeSpeech();
        if (speech) found.speech = speech;
    }
    if (needs.has('snapshots')) found.snapshots = await probeSnapshots();
    await writeFile(file, JSON.stringify(found, null, 2));
    return found;
}
