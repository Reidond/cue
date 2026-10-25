import { join } from 'node:path';
import {
    assertContains, assertNotContains, e2eCase, exists, fail, fixture, isDirectory, isFile, sameContents,
} from '../harness/index.ts';

e2eCase('A new user creates a project, drops a file on it, starts Cue and gets an answer from it.', async (cue) => {
    await cue.launch({ FAKE_CLAUDE_ANSWER: 'We studied 48 hives on six rooftops.\n- 48 hives, 6 rooftops\nSource: talk.md' });
    assertNotContains(cue.sessionLog(), /Moved your settings/, 'a new user has nothing to move');
    if (exists(cue.projectPath('My project'))) fail('no project should exist before one is created');

    cue.control('new Bee talk');
    const project = cue.projectPath('Bee talk');
    await cue.waitFor('the project folder', 10, () => isFile(join(project, 'project.json')));
    assertContains(join(project, 'project.json'), /"name" : "Bee talk"/);
    if (!isDirectory(join(project, 'Materials')) || !isDirectory(join(project, 'Notes'))) {
        fail('a project has Materials/ and Notes/');
    }

    cue.control(`add ${fixture('materials', 'talk.md')}`);
    await cue.waitFor('the copied material', 10, () => isFile(join(project, 'Materials', 'talk.md')));
    if (!sameContents(fixture('materials', 'talk.md'), join(project, 'Materials', 'talk.md'))) {
        fail('the material should be an exact copy');
    }

    cue.control('start Bee talk');
    await cue.waitLog(/Project: Bee talk/, 10);
    await cue.waitLog(/Materials for Bee talk .*talk\.md/, 30);
    assertContains(join(project, 'project.json'), /"lastUsed" : "20[0-9]{2}-/);

    cue.control('ask How many hives did you study?');
    await cue.waitLog(/Question:.*How many hives/, 20);
    await cue.waitLog(/Answer\*\* \(/, 30);
    const log = cue.sessionLog();
    assertContains(log, /Question:.*How many hives.*prepared match [0-9]+%/);
    assertContains(log, /We studied 48 hives on six rooftops/);
    const system = cue.save('system.txt', cue.claudeRequests('answer-system').join(''));
    assertContains(system, /48 hives on 6 rooftops/, "the project's materials belong in Claude's prompt");
    const asked = cue.save('asked.txt', cue.claudeRequests('ask').join(''));
    assertContains(asked, /How many hives did you study/);
});
