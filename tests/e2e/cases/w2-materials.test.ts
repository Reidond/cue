import {
    assertDeepEq,
    assertEq,
    assertTextContains,
    assertTextNotContains,
    e2eCase,
    fixture,
    literal,
    makeDocx,
    makePdf,
    makePptx,
    print,
    writeFile,
    windowText,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: Markdown, slides with speaker notes, Word and PDF files added to a project are read by the account and shown on its page, with the reason for one that cannot be read, and a removed file leaves the account and the page.',
    async (cue) => {
        const word = makeDocx(cue.path('files', 'prepared.docx'), [
            'Prepared answers for the council',
            '',
            '1. How were the hives weighed? (Smith)',
            'Answer: Every week, on a platform scale.',
            '',
            'Q: Which mites did you count?',
            'A: Varroa mites, once a month.',
        ]);
        const pdf = makePdf(cue.path('files', 'summary.pdf'), [
            'Rooftop colonies made 31 kg of honey per hive.',
            'Winter losses were 9 percent.',
        ]);
        const scan = makePdf(cue.path('files', 'scan.pdf'), []);
        const deck = makePptx(cue.path('files', 'deck.pptx'), [
            { title: 'Rooftop bees', body: '48 hives' },
            { title: 'Results', notes: ['Q: What was the yield?', 'A: 31 kg per hive.'] },
        ]);
        const unsupported = writeFile(cue.path('files', 'tool.exe'), 'MZ');
        await cue.launch();
        const shows = async (pattern: RegExp): Promise<boolean> => pattern.test(await windowText(cue.pid));
        const waitShows = (what: string, pattern: RegExp, seconds = 30) =>
            cue
                .waitFor(what, seconds, () => shows(pattern))
                .catch(async (error: unknown) => {
                    print('--- the window shows', await windowText(cue.pid));
                    throw error;
                });

        // Files are added one after the other, to the project that is open (`new` opens it).
        cue.control('new Bee talk');
        for (const file of [fixture('materials', 'talk.md'), word, pdf, deck, scan, unsupported]) cue.control(`add ${file}`);
        await cue.waitLog(/📎 Added talk\.md to Bee talk: 133 words · 3 prepared answers/, 30);
        await cue.waitLog(/📎 Added prepared\.docx to Bee talk: .* · 2 prepared answers/, 30);
        await cue.waitLog(/📎 Added summary\.pdf to Bee talk: 14 words/, 30);
        await cue.waitLog(/📎 Added deck\.pptx to Bee talk: 2 slides · 1 prepared answers/, 30);
        await cue.waitLog(/📎 Added scan\.pdf to Bee talk: No text in this PDF \(scanned\?\)/, 30);
        assertEq(cue.logCount(/tool\.exe/), 0, 'a file Cue does not read is not sent');

        // What the stand-in for Workers AI was sent, and what the account holds.
        assertDeepEq(
            cue.serviceRequests('markdown-request').map((request) => request.name),
            ['prepared.docx', 'summary.pdf', 'scan.pdf'],
            'Word and PDF files went through toMarkdown; Markdown and slides did not',
        );
        const account = await (await cue.backend()).accountOf(cue.email);
        const project = await account.project('Bee talk');
        assertDeepEq(
            (await account.materials(project)).map((material) => material.name),
            ['deck.pptx', 'prepared.docx', 'scan.pdf', 'summary.pdf', 'talk.md'],
        );
        assertTextContains(await account.text(project, 'prepared.docx'), /Every week, on a platform scale/);
        assertTextContains(await account.text(project, 'summary.pdf'), /31 kg of honey per hive/);
        assertTextContains(await account.text(project, 'deck.pptx'), /^Speaker notes:$/m);
        assertEq((await account.answers(project)).length, 3 + 2 + 1);

        // The overview: every file with what the account said about it, and why the scan is empty.
        await waitShows('the five files', /^English · 5 files$/m);
        await waitShows('what the account read', /^~\d+ tokens · 6 prepared answers$/m);
        const overview = await windowText(cue.pid);
        for (const text of [
            'talk.md',
            '133 words · 3 prepared answers',
            'prepared.docx',
            'summary.pdf',
            '14 words',
            'deck.pptx',
            '2 slides · 1 prepared answers',
            'scan.pdf',
            'No text in this PDF (scanned?)',
            'Remove scan.pdf',
        ]) {
            assertTextContains(overview, new RegExp(`^${literal(text)}$`, 'm'), `${text} is on the page`);
        }

        // The prepared answers of all the files, with where each was found.
        cue.control('page Bee talk/answers');
        await waitShows('the prepared answers', /^Which mites did you count\?$/m);
        const answers = await windowText(cue.pid);
        assertTextContains(answers, /^How many hives did you study\?$/m);
        assertTextContains(answers, /^How were the hives weighed\?$/m);
        assertTextContains(answers, /^Every week, on a platform scale\.$/m);
        assertTextContains(answers, /^Smith · prepared\.docx$/m, 'who is expected to ask it, and the file');
        assertTextContains(answers, /^What was the yield\?$/m);
        assertTextContains(answers, /^31 kg per hive\.$/m);
        assertTextContains(answers, /^deck\.pptx, slide 2 notes$/m, 'speaker notes say which slide');

        // Removing a file: it leaves the account, with its prepared answers, and the page.
        cue.control('remove Bee talk | talk.md');
        await cue.waitLog(/🗑 Removed talk\.md from Bee talk/, 30);
        assertDeepEq(
            (await account.materials(project)).map((material) => material.name),
            ['deck.pptx', 'prepared.docx', 'scan.pdf', 'summary.pdf'],
            'the account keeps the other files',
        );
        assertEq(
            (await account.answers(project)).some((answer) => answer.source === 'talk.md'),
            false,
            'and none of its prepared answers',
        );
        await cue.waitFor('the page to lose the file', 30, async () => !(await shows(/^How many hives did you study\?$/m)));
        cue.control('page Bee talk');
        await waitShows('the four files', /^English · 4 files$/m);
        assertTextNotContains(await windowText(cue.pid), /^talk\.md$/m);
    },
);
