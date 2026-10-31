import { assertContains, assertDeepEq, assertEq, e2eCase, makeDocx, makePdf } from '../harness/index.ts';

e2eCase('A PDF and a Word file dropped on a project are read by the account, and their text and prepared answers show in the app.', async (cue) => {
    const word = makeDocx(cue.path('files', 'prepared.docx'), [
        'Prepared answers for the council',
        '',
        '1. How were the hives weighed? (Smith)',
        'Answer: Every week, on a platform scale.',
        '',
        'Q: Which mites did you count?',
        'A: Varroa mites, once a month.',
    ]);
    const pdf = makePdf(cue.path('files', 'summary.pdf'), ['Rooftop colonies made 31 kg of honey per hive.', 'Winter losses were 9 percent.']);
    await cue.launch();
    cue.control('new Bee talk');
    cue.control(`add ${word}`);
    cue.control(`add ${pdf}`);
    await cue.waitLog(/Added prepared\.docx to Bee talk: .* · 2 prepared answers/, 30);
    await cue.waitLog(/Added summary\.pdf to Bee talk: 14 words/, 30);

    // What the stand-in for Workers AI was sent, and what the account holds.
    assertDeepEq(
        cue.serviceRequests('markdown-request').map((request) => request.name),
        ['prepared.docx', 'summary.pdf'],
        'both files went through toMarkdown',
    );
    const account = await (await cue.backend()).accountOf(cue.email);
    const project = await account.project('Bee talk');
    assertContains(cue.save('word.txt', await account.text(project, 'prepared.docx')), /Every week, on a platform scale/);
    assertContains(cue.save('pdf.txt', await account.text(project, 'summary.pdf')), /31 kg of honey per hive/);
    assertEq((await account.answers(project)).length, 2);

    // The project's page and its prepared answers.
    const text = cue.page;
    await cue.dashboardPage('Bee talk', /2 prepared answers/);
    assertContains(text, /prepared\.docx/);
    assertContains(text, /summary\.pdf/);
    assertContains(text, /2 files/);
    await cue.dashboardPage('Bee talk/answers', /How were the hives weighed/);
    assertContains(text, /Every week, on a platform scale/);
    assertContains(text, /Which mites did you count/);

    // Claude's prompt is built from the text the account read.
    cue.control('start Bee talk');
    await cue.waitLog(/Materials for Bee talk .*prepared\.docx.*summary\.pdf/, 30);
    await cue.waitFor("the files' text in Claude's prompt", 20, () => {
        const system = cue.claudeRequests('answer-system').at(-1) ?? '';
        return system.includes('Every week, on a platform scale') && system.includes('31 kg of honey per hive');
    });
});
