// What some cases depend on and some Macs can't do: recognize speech fast enough for the cases'
// timeouts, and draw snapshots of Cue's windows and of its overlay that Vision can read. GitHub's
// macOS runners have no GPU for whisper.cpp, and draw the hidden overlay (rendered offscreen) blank
// while capturing the dashboard fine. The runner (run.ts) probes each once per run, before the
// cases, and a case that depends on one skips with the measured reason (requirements.ts) instead
// of timing out.
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
    return (
        linesOf(text)
            .filter((line) => line.trim() !== '')
            .at(-1) ?? ''
    );
}

/** Whether whisper-cli hears a short spoken phrase, and how long it takes. */
export async function probeSpeech(): Promise<Capability | undefined> {
    const model = join(REAL_SUPPORT, 'models', 'ggml-large-v3-turbo.bin');
    const cli = ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli'].find(exists);
    // Without them the cases skip on their own (needWhisper, needWhisperCli).
    if (!exists(model) || cli === undefined) return undefined;
    const dir = await mkdtemp(join(E2E_WORK, 'probe-speech.'));
    try {
        const aiff = join(dir, 'phrase.aiff'),
            wav = join(dir, 'phrase.wav');
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
        if (heard.code === 137)
            return { ok: false, detail: `${slow} over ${SPEECH_LIMIT * 3} s (the cases need it within ${SPEECH_LIMIT} s)` };
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

/**
 * Whether Cue's snapshots read as text: its windows (the dashboard) and, separately, the overlay
 * once Start Cue has shown it, which is drawn another way (all glass, floating over the desktop).
 */
export async function probeSnapshots(): Promise<Pick<Capabilities, 'windows' | 'overlay'>> {
    const cue = await Cue.open('00-probe-snapshots');
    let dashboard = '',
        overlay = '';
    const windowsRead = (): boolean => /New Project/i.test(dashboard);
    const overlayRead = (): boolean => /Listening|No audio|When someone asks|Drop your|Ask anything/i.test(overlay);
    try {
        await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png') });
        // The dashboard opens at launch, on Home; Start Cue on a new project shows the overlay.
        cue.control('new Probe');
        cue.control('start Probe');
        const shown = Date.now() + 1000;
        for (const deadline = Date.now() + 30_000; Date.now() < deadline && !(windowsRead() && overlayRead()); await sleep(2)) {
            if (!windowsRead() && nonEmpty(cue.path('cue-dashboard.png'))) dashboard = await ocr(cue.path('cue-dashboard.png'));
            if (!overlayRead() && Date.now() > shown && nonEmpty(cue.path('cue.png'))) overlay = await ocr(cue.path('cue.png'));
        }
        const log = linesOf(readText(cue.sessionLog()) ?? '');
        const logged = (pattern: RegExp): string | undefined => log.map((line) => pattern.exec(line)?.[1]).find(Boolean);
        const windowsMethod = logged(/📸 Snapshots: (.*)/) ?? 'capture method not logged';
        const overlayMethod = logged(/📸 Overlay: (.*)/) ?? windowsMethod;
        const unreadable = (text: string, method: string): string =>
            `${text.trim() ? 'not the expected text' : 'no text'} in its snapshots here (${method})`;
        return {
            windows: windowsRead()
                ? { ok: true, detail: windowsMethod }
                : { ok: false, detail: `the dashboard shows ${unreadable(dashboard, windowsMethod)}` },
            overlay: overlayRead()
                ? { ok: true, detail: overlayMethod }
                : { ok: false, detail: `the overlay shows ${unreadable(overlay, overlayMethod)}` },
        };
    } finally {
        await cue.close(windowsRead() && overlayRead());
    }
}

/**
 * Probes what the cases about to run need, writes the results where requirements.ts reads them
 * (the file E2E_CAPABILITIES names) and returns them.
 */
export async function probeMachine(needs: ReadonlySet<'speech' | 'snapshots'>, file: string): Promise<Capabilities> {
    const found: Capabilities = {};
    if (needs.has('speech')) {
        const speech = await probeSpeech();
        if (speech) found.speech = speech;
    }
    if (needs.has('snapshots')) Object.assign(found, await probeSnapshots());
    await writeFile(file, JSON.stringify(found, null, 2));
    return found;
}
