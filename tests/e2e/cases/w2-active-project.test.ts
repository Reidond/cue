import { join } from 'node:path';
import { assertContains, assertEq, assertNotContains, e2eCase, isFile, sleep } from '../harness/index.ts';

e2eCase(
    'Cue for Windows: CUE_PROJECT picks the project Cue is bound to at sign-in (making it when missing), the next launch keeps it, and a rename follows it.',
    async (cue) => {
        await cue.launch({ CUE_PROJECT: 'Solar' });
        await cue.waitLog(/📁 Project: Solar/, 30);
        const account = await (await cue.backend()).accountOf(cue.email);
        assertEq((await account.project('Solar')).name, 'Solar', 'a project that was missing is made');
        assertContains(join(cue.projectPath('Solar'), 'project.json'), /"serverID": "/);
        assertContains(join(cue.support, 'settings.json'), /"activeProject": "Solar"/);

        // Another project does not take its place; the next launch, with no CUE_PROJECT, is bound to the one used last.
        cue.control('new Bees');
        await cue.waitFor('the second project', 15, () => isFile(join(cue.projectPath('Bees'), 'project.json')));
        await cue.stop();
        await sleep(1); // session logs are named by the second
        await cue.launch();
        await cue.waitLog(/📁 Project: Solar/, 30);
        assertEq(cue.logCount(/📁 Project: Bees/), 0);

        // Renaming the project it is bound to keeps it bound (the folder, which is its name here, changes).
        cue.control('rename-project Solar | Sun');
        await cue.waitFor('the folder to move', 30, () => isFile(join(cue.projectPath('Sun'), 'project.json')));
        assertContains(join(cue.support, 'settings.json'), /"activeProject": "Sun"/);
        await cue.stop();
        await sleep(1);
        await cue.launch();
        await cue.waitLog(/📁 Project: Sun/, 30);

        // CUE_PROJECT names an existing project: nothing is made twice.
        await cue.stop();
        await sleep(1);
        await cue.launch({ CUE_PROJECT: 'Bees' });
        await cue.waitLog(/📁 Project: Bees/, 30);
        assertEq((await account.projects()).length, 2, 'Sun and Bees');
        assertNotContains(cue.sessionLog(), /Imported/);
    },
);
