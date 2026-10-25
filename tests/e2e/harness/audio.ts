// Spoken audio for Cue to hear, made with macOS voices, and measurements of the audio it saved.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { E2E_BIN, E2E_CACHE } from './config.ts';
import { exists, linesOf } from './files.ts';
import { exec, type Ran } from './process.ts';
import { needVoice } from './requirements.ts';
import { fail } from './results.ts';

/** Writes `out` (a 16 kHz mono WAV) with `text` spoken by a macOS voice. */
export async function speech(out: string, voice: string, text: string): Promise<void> {
    await needVoice(voice);
    const aiff = out.replace(/\.wav$/, '') + '.aiff';
    const said = await exec('say', ['-v', voice, '-o', aiff, '--', text]);
    if (said.code !== 0) fail(`say -v ${voice} failed`, said.output);
    const converted = await exec('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, out]);
    if (converted.code === 0) await rm(aiff, { force: true });
}

/** A call made by `dialogue`: one WAV per side, plus when each line is said. */
export interface Dialogue {
    dir: string;
    /** timeline.tsv: start, end, side, voice and text of each line. */
    timeline: string;
    /** The side's audio: the lines of that side, silence while the others talk. */
    wav(side: string): string;
}

/** The voices a dialogue script uses: the middle field of its `side | voice | text` lines. */
function voicesIn(script: string): string[] {
    const voices = linesOf(script)
        .filter((line) => !/^\s*(#|$|pause\s*\|)/.test(line))
        .map((line) => (line.split('|')[1] ?? '').trim());
    return [...new Set(voices)].sort();
}

/**
 * Builds a call from a script of `side | voice | text` lines (and `pause | seconds`) into `out`
 * (see tools/dialogue.swift). Built once per script and cached across runs.
 */
export async function dialogue(script: string, out: string): Promise<Dialogue> {
    const bytes = await readFile(script);
    for (const voice of voicesIn(bytes.toString())) await needVoice(voice);
    const cache = join(E2E_CACHE, createHash('sha1').update(bytes).digest('hex').slice(0, 16));
    if (!exists(join(cache, 'timeline.tsv'))) {
        const built = await exec(join(E2E_BIN, 'dialogue'), [script, cache]);
        if (built.code !== 0) fail(`couldn't build dialogue from ${script}`, built.output);
    }
    await mkdir(out, { recursive: true });
    await cp(cache, out, { recursive: true });
    return { dir: out, timeline: join(out, 'timeline.tsv'), wav: (side) => join(out, `${side}.wav`) };
}

/** What `afinfo` says about an audio file. */
export function afinfo(file: string): Promise<Ran> {
    return exec('afinfo', [file]);
}

/** The file's length in seconds, as afinfo reads it; undefined when it can't. */
export async function audioLength(file: string): Promise<number | undefined> {
    const duration = /estimated duration: (\S+)/.exec((await afinfo(file)).stdout)?.[1];
    return duration === undefined ? undefined : Number(duration);
}

/**
 * Whether the recording has each line of a dialogue's timeline (only those of `sides`, when given)
 * where the timeline puts it, and silence elsewhere (see tools/audio-sync.swift), with what it measured.
 */
export async function audioSync(audio: string, timeline: string, ...sides: string[]): Promise<{ ok: boolean; output: string }> {
    const ran = await exec(join(E2E_BIN, 'audio-sync'), [audio, timeline, ...sides]);
    return { ok: ran.code === 0, output: ran.output };
}
