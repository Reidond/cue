import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    assertContains,
    assertEq,
    assertNotContains,
    countLines,
    e2eCase,
    fixture,
    isDirectory,
    needOverlaySnapshots,
    ocr,
} from '../harness/index.ts';

e2eCase("The dashboard shows Home, a project's page, its prepared answers and its notes.", async (cue) => {
    const png = cue.path('cue.png');
    const text = cue.page;
    await cue.launch({ CUE_SNAPSHOT: png });

    await cue.dashboardPage('home', /Create Your First Project/);
    // The toolbar's title; Vision on GitHub's runners reads a stray "l" after it.
    assertContains(text, /^Homel?$/);
    assertContains(text, /Upcoming$/);
    assertContains(text, /^Projects$/);
    assertContains(text, /New Project/);

    cue.control('new Bee talk');
    cue.control(`add ${fixture('materials', 'talk.md')}`);
    const notes = join(cue.projectPath('Bee talk'), 'Notes');
    await cue.waitFor('the project', 10, () => isDirectory(notes));
    await cue.waitLog(/Added talk\.md to Bee talk/, 20);
    await copyFile(fixture('notes', 'sample.md'), join(notes, '2026-10-20 10.00 – Weekly sync about the report.md'));

    await cue.dashboardPage('Bee talk', /3 prepared answers/);
    assertEq(countLines(text, /Bee talk$/), 2, "the project should be in the sidebar and the page's header");
    assertContains(text, /Start Cue/);
    assertContains(text, /About the Talk/);
    assertContains(text, /^Materials$/);
    assertContains(text, /talk\.md/);
    assertContains(text, /1 file/);

    await cue.dashboardPage('Bee talk/answers', /How many hives did you study/);
    assertContains(text, /We studied 48 hives on 6 rooftops/);
    assertContains(text, /What were the winter losses/);

    await cue.dashboardPage('Bee talk/notes', /Weekly sync about the report/);
    assertContains(text, /^Summary$/);
    assertContains(text, /send the report/);

    await cue.dashboardPage('home', /Recent Notes/);
    assertContains(text, /Weekly sync about the report/);
    assertNotContains(text, /Create Your First Project/);

    await cue.dashboardPage('upcoming', /No Upcoming Calls/);

    // The overlay names the project it answers from.
    cue.control('start Bee talk');
    await cue.waitLog(/Materials for Bee talk/, 30);
    needOverlaySnapshots();
    await cue.waitFor('the overlay to name the project', 10, async () => (await ocr(png)).includes('Bee talk'));
});
