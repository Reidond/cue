import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
    assertContains, assertEq, assertFile, assertNotContains, e2eCase, exists, fail, fixture, isFile, listDir,
    sameContents, sleep,
} from '../harness/index.ts';

e2eCase('Settings and notes from before projects become the project "My project", once.', async (cue) => {
    const oldNotes = join(cue.documents, 'Cue Recordings');
    await mkdir(oldNotes, { recursive: true });
    await copyFile(fixture('notes', 'sample.md'), join(oldNotes, '2026-10-20 10.00 – Weekly sync about the report.md'));
    await cue.defaults('materials', [fixture('materials', 'talk.md'), cue.path('gone.pdf')]);
    await cue.defaults('occasion', 'Rooftop beekeeping talk at the city council');
    await cue.defaults('language', 'uk');
    await cue.defaults('vocabulary', 'Varroa, Kyiv, linden');
    await cue.launch();
    await cue.waitLog(/Moved your settings into the project “My project”: 1 of 2 materials copied, 1 notes moved/, 20);
    await cue.waitLog(/Materials for My project .*talk\.md/, 30);

    const project = cue.projectPath('My project');
    const json = join(project, 'project.json');
    assertFile(json);
    assertContains(json, /"name" : "My project"/);
    assertContains(json, /"occasion" : "Rooftop beekeeping talk at the city council"/);
    assertContains(json, /"language" : "uk"/);
    assertContains(json, /"namesAndTerms" : "Varroa, Kyiv, linden"/);
    assertContains(json, /"created" : "20[0-9]{2}-/);

    if (!sameContents(fixture('materials', 'talk.md'), join(project, 'Materials', 'talk.md'))) {
        fail('talk.md should be copied into Materials/');
    }
    if (!isFile(fixture('materials', 'talk.md'))) fail('the original material must stay where it was');
    assertEq(listDir(join(project, 'Materials')).length, 1, 'only the file that exists is copied');

    const note = join(project, 'Notes', '2026-10-20 10.00 – Weekly sync about the report.md');
    assertFile(note, 'the old note should move into Notes/');
    if (exists(oldNotes)) fail('the emptied old recordings folder should be gone');
    assertContains(note, /^project: "My project"$/);
    assertContains(note, /^title: "Weekly sync about the report"$/);
    assertContains(note, /send the report/);

    // A second launch changes nothing.
    await cue.stop();
    await sleep(1); // session logs are named by the second
    await cue.launch();
    await cue.waitLog(/Materials for My project .*talk\.md/, 30);
    assertNotContains(cue.sessionLog(), /Moved your settings/);
    assertEq(listDir(join(cue.documents, 'Cue')).length, 1, 'still one project');
    assertEq(listDir(join(project, 'Materials')).length, 1, 'materials are not copied twice');
    assertEq(cue.findNotes().length, 1, 'still one note');
});
