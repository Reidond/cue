// The words that mark a prepared question and its answer, per spoken language (from the Mac app's Resources/lexicons, which keeps the rest
// of each lexicon until the live call moves here). A language without a lexicon, or any language when the prepared material is in English,
// still gets the English labels.

interface Labels {
    questionLabels: string[];
    answerLabels: string[];
}

const ENGLISH: Labels = { questionLabels: ['question', 'q', 'possible question', 'they may ask'], answerLabels: ['answer', 'a'] };

const LABELS: Record<string, Labels> = {
    en: ENGLISH,
    uk: { questionLabels: ['питання', 'запитання', 'можуть запитати', 'можливе питання'], answerLabels: ['відповідь', 'відп'] },
};

/** The labels for a language code (`uk`, `pt-BR`): its own first, then English. */
export function labelsFor(language: string): Labels {
    const own = LABELS[language.split('-')[0]!.toLowerCase()];
    if (!own || own === ENGLISH) return ENGLISH;
    return { questionLabels: [...own.questionLabels, ...ENGLISH.questionLabels], answerLabels: [...own.answerLabels, ...ENGLISH.answerLabels] };
}
