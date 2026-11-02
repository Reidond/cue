import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
    assertContains,
    assertDeepEq,
    assertEq,
    assertNotContains,
    assertTextContains,
    e2eCase,
    fixture,
    makeDocx,
    print,
    sleep,
    windowText,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: projects found in the library at the first sign-in are imported into the account once, with the files they kept, and show in the pane.',
    async (cue) => {
        // Projects made by hand, as the Mac's Cue (or an earlier one) leaves them: one with a file, one in Ukrainian with a Word file, and a bare folder.
        const interviews = await cue.project('Interviews', { language: 'en', occasion: 'Hiring interviews' });
        await mkdir(join(interviews, 'Materials'), { recursive: true });
        await copyFile(fixture('materials', 'talk.md'), join(interviews, 'Materials', 'talk.md'));
        const seminar = await cue.project('Семінар', { language: 'uk' });
        makeDocx(join(seminar, 'Materials', 'prepared.docx'), ['Питання: Скільки було вуликів?', 'Відповідь: Сорок вісім.']);
        await mkdir(cue.projectPath('Loose'), { recursive: true });

        await cue.launch();
        await cue.waitLog(/📦 Imported 3 projects from this PC \(2 files\)/, 60);

        const account = await (await cue.backend()).accountOf(cue.email);
        assertDeepEq((await account.projects()).map((project) => project.name).sort(), ['Interviews', 'Loose', 'Семінар']);
        const remote = await account.project('Interviews');
        assertEq(remote.occasion, 'Hiring interviews');
        assertDeepEq(
            (await account.materials(remote)).map((material) => material.name),
            ['talk.md'],
        );
        const ukrainian = await account.project('Семінар');
        assertEq(ukrainian.language, 'uk');
        assertEq((await account.answers(ukrainian))[0]?.answer, 'Сорок вісім.', "read in the project's language");
        assertEq((await account.project('Loose')).materialCount, 0, 'a folder with no project.json is a project named after it');
        assertContains(join(interviews, 'project.json'), /"serverID": "/);
        assertContains(join(cue.projectPath('Loose'), 'project.json'), /"serverID": "/);

        // The pane lists them.
        const shows = async (pattern: RegExp): Promise<boolean> => pattern.test(await windowText(cue.pid));
        await cue
            .waitFor('the pane to list the projects', 30, () => shows(/^Семінар$/m))
            .catch(async (error: unknown) => {
                print('--- the window shows', await windowText(cue.pid));
                throw error;
            });
        const pane = await windowText(cue.pid);
        for (const name of ['Interviews', 'Loose', 'Семінар'])
            assertTextContains(pane, new RegExp(`^${name}$`, 'm'), `${name} is in the pane`);

        // Once: the next launch imports nothing.
        await cue.stop();
        await sleep(1); // session logs are named by the second
        await cue.launch();
        await cue.waitLog(/Signed in to Cue/, 30);
        assertNotContains(cue.sessionLog(), /Imported/);
        assertEq((await account.projects()).length, 3, 'still three projects in the account');
        assertEq((await account.materials(remote)).length, 1, 'and one file');
    },
);
