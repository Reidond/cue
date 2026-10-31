import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertContains, assertDeepEq, assertNotContains, assertEq, e2eCase, fixture, makeDocx, sleep } from '../harness/index.ts';

e2eCase(
    'Projects found on the Mac at the first sign-in are imported into the account once, and their notes stay with them.',
    async (cue) => {
        // Two projects made by hand, as an earlier Cue left them: one with a file and a note.
        const interviews = await cue.project('Interviews', { language: 'en', occasion: 'Hiring interviews' });
        await mkdir(join(interviews, 'Materials'), { recursive: true });
        await copyFile(fixture('materials', 'talk.md'), join(interviews, 'Materials', 'talk.md'));
        await mkdir(join(interviews, 'Notes'), { recursive: true });
        await copyFile(fixture('notes', 'sample.md'), join(interviews, 'Notes', '2026-10-20 10.00 – Weekly sync about the report.md'));
        const seminar = await cue.project('Семінар', { language: 'uk' });
        makeDocx(join(seminar, 'Materials', 'prepared.docx'), ['Питання: Скільки було вуликів?', 'Відповідь: Сорок вісім.']);

        await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png') });
        await cue.waitLog(/📦 Imported 2 projects from this Mac \(2 files\)/, 30);

        const account = await (await cue.backend()).accountOf(cue.email);
        assertDeepEq((await account.projects()).map((project) => project.name).sort(), ['Interviews', 'Семінар']);
        const remote = await account.project('Interviews');
        assertEq(remote.occasion, 'Hiring interviews');
        assertDeepEq(
            (await account.materials(remote)).map((material) => material.name),
            ['talk.md'],
        );
        const ukrainian = await account.project('Семінар');
        assertEq(ukrainian.language, 'uk');
        assertEq((await account.answers(ukrainian))[0]?.answer, 'Сорок вісім.', "read in the project's language");
        assertContains(join(interviews, 'project.json'), /"serverID" : "/);

        // The note is still with its project.
        await cue.dashboardPage('Interviews/notes', /Weekly sync about the report/);
        assertEq(cue.findNotes().length, 1);

        // Once: the next launch imports nothing.
        await cue.stop();
        await sleep(1); // session logs are named by the second
        await cue.launch();
        await cue.waitLog(/Signed in to Cue/, 30);
        assertNotContains(cue.sessionLog(), /Imported/);
        assertEq((await account.projects()).length, 2, 'still two projects in the account');
        assertEq((await account.materials(remote)).length, 1, 'and one file');
    },
);
