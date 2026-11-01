// Spoken audio for Cue to hear, made with macOS voices, and measurements of the audio it saved.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

/** A 16 kHz mono 16-bit WAV header for `data` bytes of samples. */
function wavHeader(data: number): Buffer {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + data, 4);
    header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); // PCM: format 1, 1 channel, 16 kHz, 32 000 bytes a second, 2 a frame, 16 bits
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16_000, 24);
    header.writeUInt32LE(32_000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(data, 40);
    return header;
}

/** Writes `out` (a 16 kHz mono WAV) with `seconds` of digital silence: a call where nobody speaks. */
export async function silence(out: string, seconds: number): Promise<string> {
    const data = Math.round(seconds * 16_000) * 2;
    await writeFile(out, Buffer.concat([wavHeader(data), Buffer.alloc(data)]));
    return out;
}

/**
 * Writes `out` (a 16 kHz mono WAV) with `seconds` of any recording macOS can read (a screen recording's
 * .mov too), from `from` seconds in.
 */
export async function excerpt(source: string, out: string, from: number, seconds: number): Promise<string> {
    const whole = `${out}.whole.wav`;
    const converted = await exec('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', source, whole]);
    if (converted.code !== 0) fail(`afconvert couldn't read ${source}`, converted.output);
    const wav = await readFile(whole);
    await rm(whole, { force: true });
    let offset = 12;
    while (offset + 8 <= wav.length && wav.toString('ascii', offset, offset + 4) !== 'data') offset += 8 + wav.readUInt32LE(offset + 4);
    const samples = wav.subarray(offset + 8);
    const data = samples.subarray(Math.round(from * 16_000) * 2, Math.round((from + seconds) * 16_000) * 2);
    await writeFile(out, Buffer.concat([wavHeader(data.length), data]));
    return out;
}

/** A call made by `dialogue`: one WAV per side, plus when each line is said. */
export interface Dialogue {
    dir: string;
    /** timeline.tsv: start, end, side, voice and text of each line. */
    timeline: string;
    /** The side's audio: the lines of that side, silence while the others talk. */
    wav(side: string): string;
    /**
     * FAKE_DEEPGRAM_LIVE for the Deepgram stand-in: what each line says, in the order the lines start, so that the live transcript is the script (the
     * stand-in tells speech from silence by loudness and has no ears). The voices of the `call` side are numbered from 0 in the order they first speak.
     */
    live(): string;
    /**
     * FAKE_DEEPGRAM_FILE for the Deepgram stand-in's recorded files (the backend's second pass): what each side says, line by line in the order the lines
     * start, with the call side's voices numbered from 0 in the order they first speak. `said` replaces a side's lines (its array is complete: fewer
     * entries than the audio has stretches of speech means the rest is not heard; an entry with no text is a stretch Deepgram hears nothing in).
     */
    file(said?: { me?: Said[]; others?: Said[] }): string;
}

/** What a stretch of speech says in the recorded-file stand-in: its text, and on the call side the voice (from 0). */
export type Said = string | { text: string; speaker?: number };

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
    const timeline = join(out, 'timeline.tsv');
    const rows = () =>
        linesOf(readFileSync(timeline, 'utf8'))
            .map((line) => line.split('\t'))
            .filter((fields) => fields.length >= 5)
            .map(([start, , side, voice, ...text]) => ({ start: Number(start), side: side!, voice: voice!, text: text.join('\t') }))
            .sort((a, b) => a.start - b.start);
    /** The lines in order, the call side's with their voice numbered from 0 in the order the voices first speak. */
    const said = (): { side: string; said: Said }[] => {
        const voices: string[] = [];
        return rows().map((row) => {
            if (row.side === 'me') return { side: 'me', said: row.text };
            if (!voices.includes(row.voice)) voices.push(row.voice);
            return { side: 'others', said: { text: row.text, speaker: voices.indexOf(row.voice) } };
        });
    };
    const live = (): string => JSON.stringify(said().map((row) => row.said));
    const file = (replaced: { me?: Said[]; others?: Said[] } = {}): string => {
        const all = said();
        return JSON.stringify({
            me: replaced.me ?? all.filter((row) => row.side === 'me').map((row) => row.said),
            others: replaced.others ?? all.filter((row) => row.side === 'others').map((row) => row.said),
        });
    };
    return { dir: out, timeline, wav: (side) => join(out, `${side}.wav`), live, file };
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
