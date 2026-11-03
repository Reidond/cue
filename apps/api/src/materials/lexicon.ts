// The words that mark a prepared question and its answer, in every language Cue has them for (from the Mac app's Resources/lexicons). The
// spoken language is heard, not chosen, and materials are often in another language than the talk: every language's labels count.

interface Labels {
    questionLabels: string[];
    answerLabels: string[];
}

const LABELS: Labels[] = [
    { questionLabels: ['question', 'q', 'possible question', 'they may ask'], answerLabels: ['answer', 'a'] },
    { questionLabels: ['питання', 'запитання', 'можуть запитати', 'можливе питання'], answerLabels: ['відповідь', 'відп'] },
];

/** The question and answer labels of all the languages. */
export const LABELS_ALL: Labels = {
    questionLabels: LABELS.flatMap((labels) => labels.questionLabels),
    answerLabels: LABELS.flatMap((labels) => labels.answerLabels),
};
