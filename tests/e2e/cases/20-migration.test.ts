import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
    assertContains,
    assertDeepEq,
    assertEq,
    assertFile,
    assertNotContains,
    e2eCase,
    exists,
    fail,
    fixture,
    isFile,
    listDir,
    sameContents,
    sleep,
} from '../harness/index.ts';

e2eCase(
    'Settings and notes from before projects become the project "My project", once, and go up to the account at sign-in.',
    async (cue) => {
        const oldNotes = join(cue.documents, 'Cue Recordings');
        await mkdir(oldNotes, { recursive: true });
        await copyFile(fixture('notes', 'sample.md'), join(oldNotes, '2026-10-20 10.00 – Weekly sync about the report.md'));
        await cue.defaults('materials', [fixture('materials', 'talk.md'), cue.path('gone.pdf')]);
        await cue.defaults('occasion', 'Rooftop beekeeping talk at the city council');
        await cue.defaults('language', 'uk');
        await cue.defaults('vocabulary', 'Varroa, Kyiv, linden');
        await cue.launch();
        await cue.waitLog(/Moved your settings into the project “My project”: 1 of 2 materials copied, 1 notes moved/, 20);
        await cue.waitLog(/📦 Imported 1 project from this Mac \(1 file\)/, 20);
        await cue.waitLog(/📦 Imported 1 notes? from this Mac/, 30);
        await cue.waitLog(/Materials for My project .*talk\.md/, 30);

        const project = cue.projectPath('My project');
        const json = join(project, 'project.json');
        assertFile(json);
        assertContains(json, /"name" : "My project"/);
        assertContains(json, /"occasion" : "Rooftop beekeeping talk at the city council"/);
        assertContains(json, /"language" : "uk"/);
        assertContains(json, /"namesAndTerms" : "Varroa, Kyiv, linden"/);
        assertContains(json, /"created" : "20[0-9]{2}-/);
        assertContains(json, /"serverID" : "/);

        if (!sameContents(fixture('materials', 'talk.md'), join(project, 'Materials', 'talk.md'))) {
            fail('talk.md should be copied into Materials/');
        }
        if (!isFile(fixture('materials', 'talk.md'))) fail('the original material must stay where it was');
        assertEq(listDir(join(project, 'Materials')).length, 1, 'only the file that exists is copied');

        // What the account got: the settings, and the one material that existed, read by the server.
        const account = await (await cue.backend()).accountOf(cue.email);
        const remote = await account.project('My project');
        assertEq(remote.occasion, 'Rooftop beekeeping talk at the city council');
        assertEq(remote.language, 'uk');
        assertDeepEq(remote.terms, ['Varroa', 'Kyiv', 'linden']);
        assertDeepEq(
            (await account.materials(remote)).map((material) => material.name),
            ['talk.md'],
        );
        assertEq((await account.answers(remote)).length, 3, 'its prepared answers');

        // ...and so did the old note, as the account's: its summary and transcript, in the project it was moved into.
        const [stored] = await account.notes(remote);
        assertEq(stored?.title, 'Weekly sync about the report');
        assertEq(stored?.status, 'ready');
        assertEq(stored?.summary.includes('send the report'), true, "the note's summary");

        const note = join(project, 'Notes', '2026-10-20 10.00 – Weekly sync about the report.md');
        assertFile(note, 'the old note should move into Notes/');
        if (exists(oldNotes)) fail('the emptied old recordings folder should be gone');
        assertContains(note, /^project: "My project"$/);
        assertContains(note, /^title: "Weekly sync about the report"$/);
        assertContains(note, /send the report/);

        // A second launch changes nothing: not moved again, not imported again.
        await cue.stop();
        await sleep(1); // session logs are named by the second
        await cue.launch();
        await cue.waitLog(/Materials for My project .*talk\.md/, 30);
        assertNotContains(cue.sessionLog(), /Moved your settings/);
        assertNotContains(cue.sessionLog(), /Imported/);
        assertEq(listDir(join(cue.documents, 'Cue')).length, 1, 'still one project');
        assertEq((await account.projects()).length, 1, 'still one project in the account');
        assertEq((await account.materials(remote)).length, 1, 'materials are not sent twice');
        assertEq(cue.findNotes().length, 1, 'still one note');
        assertEq((await account.notes()).length, 1, 'the note is not sent twice');
    },
);
