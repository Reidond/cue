import { ANSWER_MODEL, QUICK_MODEL } from './models.ts';

// Which Claude answers a question. Claude Haiku starts an answer sooner and writes it faster, which is all a question needs when a prepared
// answer already covers it or when it asks a plain fact (who, when, how many); one that asks for reasoning (why, how does it work, compare,
// what if) or runs long goes to Claude Sonnet, and so does one the words do not place. Decided from the question's words, in every language
// Cue has them for, so routing costs no request and no time.

export type Reason = 'prepared' | 'fact' | 'reasoning' | 'long' | 'unclear';

/** Word beginnings (lower case; a trailing space ends the word) that ask for a plain fact. */
const FACT = [
    // English
    'who ',
    'whom ',
    'whose ',
    'when ',
    'where ',
    'which ',
    'how many',
    'how much',
    'how long',
    'how often',
    'how old',
    'how big',
    'how large',
    'how fast',
    'what is the',
    'what was the',
    'what are the',
    'what were the',
    "what's the",
    'what year',
    'what date',
    'what percentage',
    'what number',
    'did you',
    'do you',
    'have you',
    'is it',
    'is there',
    'are there',
    'was it',
    'was there',
    // Ukrainian
    'хто ',
    'кого ',
    'коли ',
    'де ',
    'куди ',
    'скільки',
    'котр',
    'який рік',
    'яка кількість',
    'яке значення',
    'що таке',
    'що це',
    'чи є',
    'чи був',
    'чи була',
    'чи були',
    'чи використ',
];

/** Word beginnings that ask for an explanation, a judgement or a comparison. */
const REASONING = [
    // English
    'why',
    'how does',
    'how do ',
    'how did',
    'how would',
    'how can',
    'how could',
    'how is it',
    'explain',
    'compare',
    'comparison',
    'differ',
    'versus',
    'vs ',
    'what if',
    'what would',
    'what happens',
    'justify',
    'prove',
    'limitation',
    'weakness',
    'drawback',
    'advantage',
    'disadvantage',
    'trade-off',
    'tradeoff',
    'implication',
    'alternative',
    'instead of',
    'rather than',
    'novelty',
    'contribution',
    'significance',
    'assum',
    'validat',
    'generaliz',
    'convinc',
    'reason',
    // Ukrainian
    'чому',
    'навіщо',
    'як саме',
    'яким чином',
    'як працю',
    'як ви поясн',
    'поясн',
    'порівн',
    'різниц',
    'відмінн',
    'відрізня',
    'обґрунт',
    'доведі',
    'доказ',
    'недолік',
    'переваг',
    'обмежен',
    'альтернатив',
    'новизн',
    'внесок',
    'значущ',
    'припущ',
    'а якщо',
    'що буде',
    'що станеться',
    'замість',
    'причин',
];

/** Longer questions than this many words are rarely plain facts. */
const LONG_WORDS = 18;

/** The model for a question, and why; `prepared` is the score of the prepared answer it matched, if any. */
export function route(question: string, prepared: number | null): { model: string; reason: Reason } {
    if (prepared !== null && prepared >= 0.5) return { model: QUICK_MODEL, reason: 'prepared' };
    const marks = question.match(/\?/g)?.length ?? 0;
    const text = ` ${question
        .toLowerCase()
        .replaceAll('’', "'")
        .replace(/[^\p{L}\p{N}'-]+/gu, ' ')
        .trim()} `;
    const has = (cues: string[]) => cues.some((cue) => text.includes(` ${cue}`));
    if (has(REASONING)) return { model: ANSWER_MODEL, reason: 'reasoning' };
    if (text.trim().split(' ').length > LONG_WORDS || marks > 1) return { model: ANSWER_MODEL, reason: 'long' };
    if (has(FACT)) return { model: QUICK_MODEL, reason: 'fact' };
    return { model: ANSWER_MODEL, reason: 'unclear' };
}
