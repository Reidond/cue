import { assertContains, assertDeepEq, assertNotContains, e2eCase, fixture, makeDocx } from '../harness/index.ts';

e2eCase('A material removed from a project leaves the account and Claude\'s prompt.', async (cue) => {
    const word = makeDocx(cue.path('files', 'prepared.docx'), ['Q: Which mites did you count?', 'A: Varroa mites, once a month.']);
    await cue.launch();
    cue.control('new Bee talk');
    cue.control(`add ${fixture('materials', 'talk.md')}`);
    cue.control(`add ${word}`);
    cue.control('start Bee talk');
    await cue.waitLog(/Materials for Bee talk .*prepared\.docx.*talk\.md/, 30);
    const latestSystem = (): string => cue.claudeRequests('answer-system').at(-1) ?? '';
    await cue.waitFor('both files in the prompt', 20, () => latestSystem().includes('48 hives') && latestSystem().includes('Varroa mites'));

    cue.control('remove Bee talk | talk.md');
    await cue.waitLog(/Removed talk\.md from Bee talk/, 20);
    const account = await (await cue.backend()).accountOf(cue.email);
    const project = await account.project('Bee talk');
    assertDeepEq((await account.materials(project)).map((material) => material.name), ['prepared.docx'], 'the account keeps only the other file');
    assertDeepEq((await account.answers(project)).map((answer) => answer.question), ['Which mites did you count?'], 'and only its prepared answers');

    await cue.waitLog(/Materials for Bee talk .*prepared\.docx(?!.*talk\.md)/, 30);
    await cue.waitFor('the prompt without the removed file', 20, () => !latestSystem().includes('48 hives') && latestSystem().includes('Varroa mites'));
    assertNotContains(cue.save('system.txt', latestSystem()), /48 hives/);
    assertContains(cue.path('system.txt'), /Varroa mites, once a month/);
});
