import {
    assertContains,
    assertDeepEq,
    assertEq,
    assertNotContains,
    dialogue,
    e2eCase,
    fixture,
    needOverlaySnapshots,
} from '../harness/index.ts';

/** What Claude says to the question, a line at a time. Asked for two languages, the stand-in follows each line with its translation. */
const ANSWER = [
    'We studied 48 hives on 6 rooftops in Kyiv.',
    '• Two seasons, spring to autumn',
    '• Winter losses were 9 percent, below the national average',
    'Numbers: 48 hives, 6 rooftops, 9 percent',
    'Source: talk.md',
];

/** The judge's translation of the question and each line's, in Ukrainian. */
const UKRAINIAN: Record<string, string> = {
    'How many hives did you study?': 'Скільки вуликів ви дослідили?',
    'We studied 48 hives on 6 rooftops in Kyiv.': 'Ми дослідили 48 вуликів на 6 дахах у Києві.',
    '• Two seasons, spring to autumn': '• Два сезони, з весни до осені',
    '• Winter losses were 9 percent, below the national average':
        '• Зимові втрати становили 9 відсотків, менше за середній показник по країні',
    'Numbers: 48 hives, 6 rooftops, 9 percent': 'Цифри: 48 вуликів, 6 дахів, 9 відсотків',
    'Source: talk.md': 'Джерело: talk.md',
    'The study ran for two seasons.': 'Дослідження тривало два сезони.',
};

e2eCase(
    'Someone who reads Cue in two languages sees each question and answer in both on the overlay: as subtitles (each line with ' +
        'its translation under it), side by side (two columns under the languages’ names) or in focus (the translations in one ' +
        'paragraph under the answer); with one language again, an answer is in that one alone.',
    async (cue) => {
        needOverlaySnapshots();
        const png = cue.path('cue.png');
        const backend = await cue.backend();
        // English and Ukrainian are the account's (chosen on another Mac, say): Cue reads them when it signs in.
        await backend.invite(cue.email);
        const account = await backend.accountOf(cue.email);
        const put = await backend.call('PUT', '/v1/me/languages', account.token, { body: { languages: ['en', 'uk'] } });
        assertEq(put.status, 200, 'the account takes the two languages');

        await cue.project('Bee talk', { language: 'en' });
        await cue.defaults('autoAnswer', true);
        // Without the transcript under it the overlay has room for the whole answer.
        await cue.defaults('showTranscript', false);
        const call = await dialogue(fixture('dialogues', 'question.txt'), cue.path('call'));
        await cue.launch({
            CUE_PROJECT: 'Bee talk',
            CUE_SNAPSHOT: png,
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            FAKE_DEEPGRAM_LIVE: call.live(),
            FAKE_CLAUDE_ANSWER: ANSWER.join('\n'),
            FAKE_CLAUDE_ANSWERS: JSON.stringify({ 'how long': 'The study ran for two seasons.\n• From spring to autumn' }),
            FAKE_CLAUDE_TRANSLATIONS: JSON.stringify(UKRAINIAN),
        });
        await cue.waitLog(/🌐 Languages: English, Ukrainian$/, 30);
        await cue.waitLog(/❓ \*\*Question:\*\* How many hives did you study\?/, 120);
        await cue.waitLog(/💬 \*\*Answer\*\* \(/, 60);
        const log = cue.sessionLog();
        assertContains(log, /^We studied 48 hives on 6 rooftops in Kyiv\.$/, 'the answer is in the language spoken');
        assertContains(log, /^» Ми дослідили 48 вуликів на 6 дахах у Києві\.$/, 'each line followed by its translation');
        assertContains(log, /^» Цифри: 48 вуликів, 6 дахів, 9 відсотків$/, 'the labels translated too');

        /** The overlay's text once a snapshot shows `pattern` (each layout draws within a snapshot or two). */
        const overlay = async (name: string, pattern: RegExp): Promise<string> => {
            let shown = '';
            await cue.waitFor(`the overlay to show ${name}`, 40, async () => {
                shown = await cue.snapshotText(png);
                return pattern.test(shown);
            });
            return cue.save(`overlay-${name.replace(/\s+/g, '-')}.txt`, shown);
        };

        // Subtitles, the default: each line, and under it its translation; the question's translation under the question.
        const subtitles = await overlay('subtitles', /дослідили 48 вуликів/i);
        assertContains(subtitles, /How many hives did you study/);
        assertContains(subtitles, /Скільки вуликів ви дослідили/, 'the question in Ukrainian');
        assertContains(subtitles, /We studied 48 hives/);
        assertContains(subtitles, /Two seasons, spring to autumn/);
        assertContains(subtitles, /Два сезони, з весни до осені/, 'a point’s translation');
        assertContains(subtitles, /48 вуликів, 6 дахів, 9 відсотків/, 'the numbers’ translation');
        assertNotContains(subtitles, /Ukrainian/, 'no column headers');

        // Side by side: the overlay widens for two columns, each under its language's name.
        cue.control('answer-layout mirror');
        const mirror = await overlay('side by side', /Ukrainian/i);
        assertContains(mirror, /English/);
        assertContains(mirror, /We studied 48 hives/);
        assertContains(mirror, /дослідили 48 вуликів/);
        assertContains(mirror, /Два сезони/);

        // Focus: the answer as with one language, then the translations in one paragraph after "UK ·".
        cue.control('answer-layout focus');
        const focus = await overlay('focus', /^UK\b/m);
        assertContains(focus, /We studied 48 hives/);
        assertContains(focus, /Two seasons, spring to autumn/);
        assertContains(focus, /дослідили 48 вуликів/);
        assertNotContains(focus, /Ukrainian/, 'no column headers');

        // One language again (through the app, as Settings does): the next answer is in English alone, in every layout.
        cue.control('languages en');
        await cue.waitLog(/🌐 Languages: English$/, 20);
        assertDeepEq(
            ((await backend.call('GET', '/v1/me', account.token)).body as { languages: string[] }).languages,
            ['en'],
            'the app saved the one language to the account',
        );
        cue.control('ask How long did the study run?');
        await cue.waitLog(/^The study ran for two seasons\.$/, 60);
        const one = await overlay('one language', /The study ran for two seasons/);
        assertNotContains(one, /Дослідження тривало/, 'with one language the answer is not translated');
        assertNotContains(cue.sessionLog(), /^» Дослідження/, 'nor asked for in another language');
    },
);
