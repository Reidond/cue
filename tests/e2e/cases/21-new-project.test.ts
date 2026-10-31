import { join } from 'node:path';
import { assertContains, assertDeepEq, assertEq, assertNotContains, e2eCase, exists, fail, fixture, isDirectory, isFile } from '../harness/index.ts';

e2eCase('A new user creates a project, drops a file on it, starts Cue and gets an answer from it.', async (cue) => {
    await cue.launch({ FAKE_CLAUDE_ANSWER: 'We studied 48 hives on six rooftops.\n- 48 hives, 6 rooftops\nSource: talk.md' });
    assertNotContains(cue.sessionLog(), /Moved your settings/, 'a new user has nothing to move');
    assertNotContains(cue.sessionLog(), /Imported/, 'and nothing to import');
    if (exists(cue.projectPath('My project'))) fail('no project should exist before one is created');
    const account = await (await cue.backend()).accountOf(cue.email);
    assertEq((await account.projects()).length, 0, 'the account starts with no projects');

    cue.control('new Bee talk');
    const project = cue.projectPath('Bee talk');
    await cue.waitFor('the project folder', 10, () => isFile(join(project, 'project.json')));
    assertContains(join(project, 'project.json'), /"name" : "Bee talk"/);
    if (!isDirectory(join(project, 'Notes'))) fail('a project has a Notes/ folder here');
    const remote = await account.project('Bee talk');
    assertEq(remote.materialCount, 0);

    // The file goes to the account, which reads it.
    cue.control(`add ${fixture('materials', 'talk.md')}`);
    await cue.waitLog(/Added talk\.md to Bee talk: 133 words · 3 prepared answers/, 20);
    assertDeepEq((await account.materials(remote)).map((material) => material.name), ['talk.md'], 'the file is in the account');
    if (isDirectory(join(project, 'Materials'))) fail('nothing is copied into the project folder any more');

    cue.control('start Bee talk');
    await cue.waitLog(/Project: Bee talk/, 10);
    await cue.waitLog(/Materials for Bee talk .*talk\.md/, 30);
    assertContains(join(project, 'project.json'), /"lastUsed" : "20[0-9]{2}-/);
    await cue.waitLog(/Saved “Bee talk” to your account/, 10);
    assertEq((await account.project('Bee talk')).lastUsedAt === null, false, 'the account knows when it was used');

    cue.control('ask How many hives did you study?');
    await cue.waitLog(/Question:.*How many hives/, 20);
    await cue.waitLog(/Answer\*\* \(/, 30);
    const log = cue.sessionLog();
    assertContains(log, /Question:.*How many hives.*prepared match [0-9]+%/);
    assertContains(log, /We studied 48 hives on six rooftops/);
    const system = cue.save('system.txt', cue.claudeRequests('answer-system').join(''));
    assertContains(system, /48 hives on 6 rooftops/, "the account's text of the project's materials belongs in Claude's prompt");
    const asked = cue.save('asked.txt', cue.claudeRequests('ask').join(''));
    assertContains(asked, /How many hives did you study/);
});
