import {
    assertDeepEq,
    assertEq,
    assertTextContains,
    assertTextNotContains,
    e2eCase,
    expand,
    fixture,
    press,
    print,
    writeFile,
    windowText,
} from '../harness/index.ts';

/** What the Anthropic stand-in writes as the brief of the bee talk. */
const BRIEF = {
    occasion: 'A talk on rooftop beekeeping in Kyiv; the city council asks the questions.',
    namesAndTerms: ['Varroa destructor', 'Olena Mulesa'],
    answers: [
        { question: 'Do the bees bother the neighbours?', answer: 'Nobody complained in two seasons.', who: null, source: 'talk.md' },
    ],
};

/** The lines of what the window shows, and where each of these is among them (-1 when it is not there). */
const placesOf = (text: string, ...lines: string[]): number[] => lines.map((line) => text.split('\n').indexOf(line));

e2eCase(
    'Cue for Windows: Cue reads the files added to a project and prepares the rest from them; the Overview has the materials first, then how the ' +
        'reading went (with Try Again when it failed), and the occasion and names and terms under Advanced; the prepared answers are the ' +
        "files' own, then Cue's.",
    async (cue) => {
        cue.standIns({ FAKE_CLAUDE_BRIEF: JSON.stringify(BRIEF) });
        // Long enough a wait for the files to settle that the page is seen while Cue reads them.
        await cue.launch({}, { backend: { env: { BRIEF_SETTLE_SECONDS: '8' } } });
        const shows = async (pattern: RegExp): Promise<boolean> => pattern.test(await windowText(cue.pid));
        const waitShows = (what: string, pattern: RegExp, seconds = 30) =>
            cue
                .waitFor(what, seconds, () => shows(pattern))
                .catch(async (error: unknown) => {
                    print('--- the window shows', await windowText(cue.pid));
                    throw error;
                });
        const account = await (await cue.backend()).accountOf(cue.email);

        // A new project: its materials (none yet) and Advanced, folded; nothing else to fill in, and no language to choose.
        cue.control('new Bee talk');
        await waitShows('the project page', /^Drop slides, documents and notes here$/m);
        const empty = await windowText(cue.pid);
        assertTextContains(empty, /^Advanced$/m);
        assertTextNotContains(empty, /^(Occasion|Names and terms|Language)$/m, 'everything else is folded away under Advanced');
        assertTextNotContains(empty, /^Cue hasn't read these files yet$/m, 'with no files there is nothing to read');

        // A file: Cue reads it, and the page says so while it does.
        cue.control(`add ${fixture('materials', 'talk.md')}`);
        await cue.waitLog(/📎 Added talk\.md to Bee talk: 133 words · 3 prepared answers/, 30);
        await waitShows('Cue reading the file', /^Reading your materials…$/m, 15);
        await cue.waitLog(/✨ Prepared “Bee talk” from its materials: 1 answer, 2 names and terms/, 60);
        const project = await account.briefed('Bee talk');
        assertEq(project.brief.state, 'ready', JSON.stringify(project.brief));
        assertEq(project.occasion, '', "the person's own fields stay empty");
        assertDeepEq(project.terms, BRIEF.namesAndTerms, "Cue's names and terms are the ones in use");

        // The Overview: the materials first, then what Cue prepared, then Advanced, still folded.
        const prepared = 'Prepared 1 answer and 2 names and terms from your materials';
        await waitShows('what Cue prepared', new RegExp(`^${prepared}$`, 'm'));
        await waitShows('what the account read', /^~\d+ tokens · 4 prepared answers$/m);
        const overview = await windowText(cue.pid);
        cue.save('overview.txt', overview);
        const order = placesOf(overview, 'Materials', 'talk.md', prepared, 'Advanced');
        assertEq(
            order.every((index, at) => index >= 0 && (at === 0 || index > order[at - 1]!)),
            true,
            `the materials, then what Cue prepared, then Advanced: ${order.join(', ')}`,
        );
        assertTextContains(overview, /^Show Answers$/m);
        assertTextNotContains(overview, /^(Occasion|Names and terms|Language)$/m, 'Advanced is folded');

        // Advanced: the person's own words, empty (Cue's are used); typing there replaces Cue's.
        await expand(cue.pid, 'Advanced');
        await waitShows('the fields under Advanced', /^Names and terms$/m);
        const advanced = await windowText(cue.pid);
        assertTextContains(advanced, /^Occasion$/m);
        assertTextContains(
            advanced,
            /^Cue writes these from your materials\. Type to use your own words instead; clear a field to go back/m,
        );
        assertTextNotContains(advanced, /^Language$/m, 'there is no language to choose');
        await press(cue.pid, 'Names and terms', 'linden');
        await cue.waitLog(/☁️ Saved “Bee talk” to your account/, 20);
        await cue.waitFor(
            'their own names and terms to be in use',
            20,
            async () => (await account.project('Bee talk')).terms.join() === 'linden',
        );
        assertEq((await account.project('Bee talk')).brief.namesAndTerms, BRIEF.namesAndTerms.join('\n'), "Cue's are kept beside them");

        // Show Answers: the files' own first, then Cue's.
        await press(cue.pid, 'Show Answers');
        await waitShows('the prepared answers', /^Do the bees bother the neighbours\?$/m);
        const answers = await windowText(cue.pid);
        cue.save('answers.txt', answers);
        const groups = placesOf(
            answers,
            'From Your Files',
            'How many hives did you study?',
            'Prepared by Cue',
            'Do the bees bother the neighbours?',
        );
        assertEq(
            groups.every((index, at) => index >= 0 && (at === 0 || index > groups[at - 1]!)),
            true,
            `the files' answers, then Cue's: ${groups.join(', ')}`,
        );
        assertTextContains(answers, /^Nobody complained in two seasons\.$/m);

        // Claude fails every time: the Overview says why, with Try Again; asked again once Claude answers, it is written.
        cue.standIns({ FAKE_ANTHROPIC_BRIEF_FAILS: '1000' });
        cue.control('page Bee talk');
        cue.control(`add ${writeFile(cue.path('files', 'notes.md'), 'A hive gives 20 kg of honey.\n')}`);
        await cue.waitLog(/📎 Added notes\.md to Bee talk/, 30);
        await cue.waitLog(/Couldn't prepare “Bee talk” from its materials: Claude: The brief failed/, 120);
        await waitShows('why it failed', /^Claude: The brief failed$/m);
        assertTextContains(await windowText(cue.pid), /^Try Again$/m);
        cue.standIns({ FAKE_ANTHROPIC_BRIEF_FAILS: '0' });
        await press(cue.pid, 'Try Again');
        await cue.waitFor('the brief written again', 60, () => cue.logCount(/✨ Prepared “Bee talk” from its materials/) === 2);
        await waitShows('what Cue prepared, again', new RegExp(`^${prepared}$`, 'm'));
        assertTextNotContains(await windowText(cue.pid), /^Try Again$/m, 'the failure is over');
        assertEq((await account.project('Bee talk')).brief.state, 'ready');
    },
);
