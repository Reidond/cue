import {
    assertDeepEq,
    assertEq,
    assertTextContains,
    assertTextNotContains,
    e2eCase,
    fail,
    fixture,
    sleep,
    writeFile,
} from '../harness/index.ts';

/** What the Anthropic stand-in writes as the brief of the bee talk. */
const BRIEF = {
    occasion: 'A talk on rooftop beekeeping in Kyiv; the city council asks the questions.',
    namesAndTerms: ['Varroa destructor', 'Olena Mulesa', 'Kyiv'],
    answers: [
        {
            question: 'How much honey does a rooftop hive give?',
            answer: 'About twenty kilograms a season.',
            who: 'Smith',
            source: 'notes.md p. 2',
        },
        { question: 'Do the bees bother the neighbours?', answer: 'Nobody complained in two seasons.', who: null, source: 'talk.md' },
    ],
};

e2eCase(
    "Cue writes a project's brief from its materials once they settle: the occasion, the names and terms, and answers to the likely " +
        'questions after the ones the files have; the person’s own words replace it, and calls go by it.',
    async (cue) => {
        cue.standIns({ FAKE_CLAUDE_BRIEF: JSON.stringify(BRIEF) });
        const backend = await cue.backend();
        const email = 'ann@cue.test';
        await backend.invite(email);
        const account = await backend.accountOf(email);
        const token = account.token;
        const created = await backend.call('POST', '/v1/projects', token, { body: { name: 'Bee talk' } });
        const base = `/v1/projects/${(created.body as { id: string }).id}`;

        // Two files dropped together: Cue waits for them to settle and reads them once.
        for (const path of [
            fixture('materials', 'talk.md'),
            writeFile(cue.path('files', 'notes.md'), '[p. 2] A hive gives 20 kg of honey.\n'),
        ]) {
            assertEq((await backend.call('POST', `${base}/materials`, token, { file: { path } })).status, 201);
        }
        assertEq((await account.project('Bee talk')).brief.state, 'working', 'Cue is reading the files');
        const project = await account.briefed('Bee talk');
        assertEq(project.brief.state, 'ready', JSON.stringify(project.brief));
        assertEq(cue.claudeRequests('brief-input').length, 1, 'both files were read in one go');
        const read = cue.claudeRequests('brief-input')[0]!;
        assertTextContains(read, /^## talk\.md$/, 'Claude read the materials');
        assertTextContains(read, /^## notes\.md$/);
        assertTextContains(read, /^- How many hives did you study\?$/, 'and was told which questions the files answer already');
        assertTextContains(cue.claudeRequests('brief-system')[0]!, /^You read the materials/);

        // What it wrote: the occasion, the names and terms (in use as the keyterms), the questions answered.
        assertEq(project.brief.occasion, BRIEF.occasion);
        assertEq(project.brief.namesAndTerms, 'Varroa destructor\nOlena Mulesa\nKyiv');
        assertEq(project.brief.answerCount, 2);
        assertEq(project.occasion, '', "the person's own fields stay empty");
        assertDeepEq(project.terms, ['Varroa destructor', 'Olena Mulesa', 'Kyiv'], 'the brief’s names and terms are the ones in use');
        const answers = await account.answers(project);
        assertDeepEq(
            answers.map((item) => `${item.from}: ${item.question}`),
            [
                'materials: How many hives did you study?',
                'materials: Why did you put the hives on rooftops?',
                'materials: What were the winter losses?',
                'cue: How much honey does a rooftop hive give?',
                'cue: Do the bees bother the neighbours?',
            ],
            "the files' own answers first, then Cue's",
        );
        const materials = await account.materials(project);
        const idOf = (name: string) => materials.find((material) => material.name === name)?.id ?? fail(`no ${name}`);
        assertEq(answers[3]?.materialId, idOf('notes.md'), 'an answer belongs to the file its source names');
        assertEq(answers[3]?.who ?? undefined, 'Smith');
        assertEq(answers[4]?.materialId, idOf('talk.md'));
        const usage = await backend.rows("SELECT model, unit FROM usage WHERE feature = 'materials_brief'");
        assertEq(
            usage.some((row) => row['unit'] === 'input_tokens'),
            true,
            `the reading is the person's usage: ${JSON.stringify(usage)}`,
        );

        // A call goes by the brief: its occasion in Claude's prompt, its answers among the prepared ones.
        const prompt = async () => {
            await cue.waitFor('the call to warm its prompt', 30, () => cue.claudeRequests('answer-system').length > 0);
            return cue.claudeRequests('answer-system').at(-1)!;
        };
        const call = await backend.call('POST', '/v1/calls', token, { body: { projectId: project.id, speaker: 'Ann' } });
        assertEq(call.status, 201);
        const system = await prompt();
        assertTextContains(system, /Occasion: A talk on rooftop beekeeping in Kyiv; the city council asks the questions\./);
        assertTextContains(system, /^Question \(Smith\): How much honey does a rooftop hive give\?$/, "Cue's answers are prepared answers");
        assertTextContains(system, /^Question: How many hives did you study\?$/, "and so are the files' own");
        await backend.call('POST', `/v1/calls/${(call.body as { callId: string }).callId}/end`, token);

        // The person's own words replace the brief's; clearing them goes back to it.
        await backend.call('PATCH', base, token, { body: { occasion: 'A pre-defense', namesAndTerms: 'linden' } });
        assertDeepEq((await account.project('Bee talk')).terms, ['linden'], 'their own names and terms are listened for');
        assertEq((await account.project('Bee talk')).brief.occasion, BRIEF.occasion, 'the brief is kept beside them');
        await backend.call('PATCH', base, token, { body: { namesAndTerms: '' } });
        assertDeepEq((await account.project('Bee talk')).terms, ['Varroa destructor', 'Olena Mulesa', 'Kyiv'], 'empty: the brief’s again');

        // Removing a file reads the rest again; removing the last one clears the brief.
        for (const material of materials) {
            assertEq((await backend.call('DELETE', `${base}/materials/${material.id}`, token)).status, 200);
            await sleep(0.2);
        }
        const empty = await account.project('Bee talk');
        assertEq(empty.brief.state, 'none', 'no files, no brief');
        assertEq(empty.brief.occasion, '');
        assertDeepEq(empty.terms, [], 'and nothing of it is listened for');
        assertTextNotContains(JSON.stringify(await account.answers(empty)), /honey/, 'nor answered from');
        await sleep(5);
        assertEq(cue.claudeRequests('brief-input').length, 1, 'the files removed one after another were never read again');
        assertEq((await account.project('Bee talk')).brief.state, 'none', 'and nothing came back to life afterwards');
    },
);
