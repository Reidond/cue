// Per-language data of the live path (from the Mac app's Resources/lexicons, which keeps the rest for the notes until PR 6): the language's
// name for the prompts, the stop words that keep prepared-answer matching about the point, and the spoken openers.

export interface CallLexicon {
    name: string;
    stopWords: Set<string>;
    /** A prepared answer's own thanks, dropped from the opener (the person says it themselves). */
    thanksPrefix: string;
    /** What to say first when no prepared answer matches. */
    defaultOpener: string;
    numbersLabel: string;
    sourceLabel: string;
}

const LEXICONS: Record<string, CallLexicon> = {
    en: {
        name: 'English',
        stopWords: new Set(
            'what which that this these those with from your have does could would please about there their they were been into also tell'.split(
                ' ',
            ),
        ),
        thanksPrefix: 'Thank you for the question. ',
        defaultOpener: 'Thank you for the question. Let me briefly explain.',
        numbersLabel: 'Numbers',
        sourceLabel: 'Source',
    },
    uk: {
        name: 'Ukrainian',
        stopWords: new Set(
            'який яка яке які яким якою якого якій чому скажіть будь ласка поясніть дисертації роботі роботи вашій ваша ваші вами також можна цей для від при між або так все дуже'.split(
                ' ',
            ),
        ),
        thanksPrefix: 'Дякую за запитання. ',
        defaultOpener: 'Дякую за запитання. Дозвольте коротко пояснити.',
        numbersLabel: 'Цифри',
        sourceLabel: 'Джерело',
    },
};

/** The lexicon for a language code (`uk`, `pt-BR`); a language without one still gets English labels and no stop words. */
export function lexiconFor(code: string): CallLexicon {
    const base = code.split('-')[0]!.toLowerCase();
    const own = LEXICONS[base];
    if (own) return own;
    let name = code;
    try {
        name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
    } catch {
        /* not a language code Intl knows */
    }
    const english = LEXICONS['en']!;
    return {
        name,
        stopWords: new Set(),
        thanksPrefix: '',
        defaultOpener: '',
        numbersLabel: english.numbersLabel,
        sourceLabel: english.sourceLabel,
    };
}
