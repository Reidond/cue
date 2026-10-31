// The words a note is made of in a language: what the transcript calls the people on the call, its heading, and the words that give away a
// remark about the transcript in a summary. From the Mac app's Resources/lexicons (which keep the rest for the app's own use).

export interface NoteLexicon {
    /** The label of "everyone else" on the call. */
    participant: string;
    /** One of several voices told apart: «Учасник 2», "Participant 2". */
    numbered(number: number): string;
    /** Whether a name is one of the labels Cue gives the people on the call, rather than a name. */
    isLabel(name: string): boolean;
    transcriptHeading: string;
    /** Parenthetical remarks with one of these (at the start of a word) are dropped from a summary. */
    remarkWords: string[];
}

interface Data {
    participant: string;
    numbered: string;
    heading: string;
    remarkWords: string[];
}

const ENGLISH: Data = {
    participant: 'Participant',
    numbered: 'Participant %d',
    heading: 'Transcript',
    remarkWords: [
        'transcript',
        'transcribed as',
        'speech recognition',
        'recognition error',
        'recognized as',
        'misrecogni',
        'misheard',
        'mis-heard',
        'mishear',
        'inaudible',
        'in the recording',
        'the recording says',
    ],
};

const DATA: Record<string, Data> = {
    en: ENGLISH,
    uk: {
        participant: 'Учасник',
        numbered: 'Учасник %d',
        heading: 'Транскрипт',
        remarkWords: [
            'транскрипт',
            'транскрибов',
            'розшифров',
            'розпізнав',
            'розпізнан',
            'у записі',
            'в записі',
            'почулося',
            'нерозбірлив',
        ],
    },
};

/** The lexicon for a language code (`uk`, `pt-BR`); a language without one gets the English labels. */
export function noteLexicon(code: string): NoteLexicon {
    const base = code.split('-')[0]!.toLowerCase();
    const own = DATA[base] ?? ENGLISH;
    // Prepared materials are often in English even when the talk is not (and so can be an aside in a summary).
    const remarkWords = base === 'en' ? own.remarkWords : [...own.remarkWords, ...ENGLISH.remarkWords];
    const [before = '', after = ''] = own.numbered.split('%d');
    return {
        participant: own.participant,
        numbered: (number) => own.numbered.replace('%d', String(number)),
        isLabel: (name) =>
            name === own.participant ||
            (name.startsWith(before) && name.endsWith(after) && /^\d+$/.test(name.slice(before.length, name.length - after.length))),
        transcriptHeading: own.heading,
        remarkWords,
    };
}
