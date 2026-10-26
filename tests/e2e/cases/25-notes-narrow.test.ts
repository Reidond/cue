import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertContains, e2eCase, fixture } from '../harness/index.ts';

e2eCase('In a dashboard as narrow as it goes, the Notes page fits: the sidebar, Start Cue and the open note are whole, '
    + 'the note wrapping to the room it has.', async (cue) => {
    const project = await cue.project('Bee talk', { language: 'en' });
    await mkdir(join(project, 'Notes'), { recursive: true });
    await copyFile(fixture('notes', 'sample.md'), join(project, 'Notes', '2026-10-24 14.05 – Weekly sync about the report.md'));
    await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png') });

    cue.control('size 820 700');
    await cue.dashboardPage('Bee talk/notes', /Start Cue/);
    const page = cue.page;
    // Vision reads the sidebar's icons as a bullet, a letter or nothing; cut off, these were "ne" and "oming".
    assertContains(page, /(^|\s)Home$/, "the sidebar shouldn't be cut off on the left");
    assertContains(page, /(^|\s)Upcoming$/, "the sidebar shouldn't be cut off on the left");
    assertContains(page, /Start Cue/, "nor the header's button on the right");
    assertContains(page, /Weekly sync about/, 'the note is open');
    assertContains(page, /report by Friday\.$/, 'its summary wraps rather than running off the edge');
    assertContains(page, /Andrii, Participant$/, 'and who was on the call reads whole');
});
