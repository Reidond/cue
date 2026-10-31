import { env } from 'cloudflare:workers';
import { SPEECH_MODEL } from '../call/models.ts';
import { termsOf } from '../projects.ts';
import type { Channel, Line, Voice } from './transcript.ts';

// Deepgram's recorded-file API (DEEPGRAM_URL), with the owner's key: one side of a recording in, its utterances and (on the call side) who
// spoke when out. Nothing of the user's token ever goes here.

/** Keyterm prompting takes up to 500 tokens of terms; Deepgram suggests the 20–50 that matter most. */
const MAX_TERMS = 50;

export interface Transcribed {
    lines: Line[];
    /** Who spoke when, from the words' speakers (empty without `diarize`). */
    voices: Voice[];
    /** The length of the audio Deepgram heard (what it bills). */
    seconds: number;
}

interface Word {
    start: number;
    end: number;
    speaker?: number;
}

interface Reply {
    metadata?: { duration?: number };
    results?: {
        utterances?: { start: number; end: number; transcript: string; speaker?: number }[];
        channels?: { alternatives?: { words?: Word[] }[] }[];
    };
}

/** What a refusal means for the person; never the provider's own words about keys or accounts. */
function refusal(status: number): string {
    if (status === 401 || status === 403) return 'Speech recognition is unavailable (the plan’s key was refused)';
    if (status === 402) return 'Speech recognition is unavailable (the plan is out of credit)';
    if (status === 429) return 'Speech recognition is busy right now (too many requests at once)';
    return `Speech recognition failed (error ${status})`;
}

/** Runs of the same voice among the words. */
export function voicesOf(words: Word[]): Voice[] {
    const voices: Voice[] = [];
    for (const word of words) {
        if (word.speaker === undefined) continue;
        const last = voices.at(-1);
        if (last && last.voice === String(word.speaker)) last.end = word.end;
        else voices.push({ voice: String(word.speaker), start: word.start, end: word.end });
    }
    return voices;
}

/** Reads one side's recording (an R2 object) with Nova-3: the project's language and its names and terms. */
export async function transcribe(
    audio: R2ObjectBody,
    side: Channel,
    options: { language: string; namesAndTerms: string },
): Promise<Transcribed> {
    const query = new URLSearchParams({
        model: SPEECH_MODEL,
        language: options.language,
        smart_format: 'true',
        punctuate: 'true',
        utterances: 'true',
        tag: side,
    });
    if (side === 'others') query.set('diarize', 'true');
    for (const term of termsOf(options.namesAndTerms).slice(0, MAX_TERMS)) query.append('keyterm', term);
    // The body is a stream, so memory stays flat however long the recording is; Deepgram wants its length.
    const body = new FixedLengthStream(audio.size);
    void audio.body.pipeTo(body.writable);
    const response = await fetch(`${new URL('/v1/listen', env.DEEPGRAM_URL).href}?${query.toString().replaceAll('+', '%20')}`, {
        method: 'POST',
        headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}`, 'Content-Type': 'audio/wav' },
        body: body.readable,
    });
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(refusal(response.status));
    }
    const reply = await response.json<Reply>();
    const lines: Line[] = (reply.results?.utterances ?? [])
        .map((utterance) => ({
            channel: side,
            speaker: null,
            text: utterance.transcript.trim(),
            start: utterance.start,
            end: Math.max(utterance.start, utterance.end),
        }))
        .filter((line) => line.text !== '');
    const words = reply.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];
    return { lines, voices: side === 'others' ? voicesOf(words) : [], seconds: reply.metadata?.duration ?? 0 };
}
