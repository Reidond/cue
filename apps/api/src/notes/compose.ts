import type { Turn } from '@cue/contract';
import type { NoteLexicon } from './lexicon.ts';
import { type Channel, type Line, turnsOf } from './transcript.ts';

// Who the transcript says said each line, and who is on the call.

/** The user's own label: their name, or "You". */
export const userLabel = (speaker: string) => (speaker.trim() === '' ? 'You' : speaker.trim());

/** The label of a line's author: the user, one of several voices on the call side, or everyone else. */
export const labeller =
    (lexicon: NoteLexicon, speaker: string) =>
    (channel: Channel, voice: number | null): string =>
        channel === 'me' ? userLabel(speaker) : voice === null ? lexicon.participant : lexicon.numbered(voice);

/** The user first, then the call side: one label, or one per voice when several were told apart. */
export function participantsOf(lexicon: NoteLexicon, speaker: string, lines: Line[]): string[] {
    const voices = [
        ...new Set(lines.filter((line) => line.channel === 'others' && line.speaker !== null).map((line) => line.speaker!)),
    ].toSorted((a, b) => a - b);
    return [userLabel(speaker), ...(voices.length > 1 ? voices.map((voice) => lexicon.numbered(voice)) : [lexicon.participant])];
}

export const turnsFor = (lexicon: NoteLexicon, speaker: string, lines: Line[]): Turn[] => turnsOf(lines, labeller(lexicon, speaker));
