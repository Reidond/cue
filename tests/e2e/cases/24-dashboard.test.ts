import { readFileSync } from 'node:fs';
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

/** What the Anthropic stand-in writes from the project's materials. */
const BRIEF = {
    occasion: 'A talk on rooftop beekeeping in Kyiv.',
    namesAndTerms: ['Varroa destructor', 'linden'],
    answers: [
        { question: 'Do the bees bother the neighbours?', answer: 'Nobody complained in two seasons.', who: null, source: 'talk.md' },
    ],
};

e2eCase(
    "The dashboard shows Home, a project's page with its materials first and the rest under Advanced, its prepared answers (the files' own " +
        "and Cue's) and its notes.",
    async (cue) => {
        const png = cue.path('cue.png');
        const text = cue.page;
        await cue.launch({ CUE_SNAPSHOT: png, FAKE_CLAUDE_BRIEF: JSON.stringify(BRIEF) });

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
        await cue.waitLog(/✨ Prepared “Bee talk” from its materials: 1 answer, 2 names and terms/, 60);
        await copyFile(fixture('notes', 'sample.md'), join(notes, '2026-10-20 10.00 – Weekly sync about the report.md'));

        await cue.dashboardPage('Bee talk', /4 prepared answers/);
        assertEq(countLines(text, /Bee talk$/), 2, "the project should be in the sidebar and the page's header");
        assertContains(text, /Start Cue/);
        assertContains(text, /^Materials$/);
        assertContains(text, /talk\.md/);
        assertContains(text, /1 file/);
        assertContains(text, /Prepared 1 answer and 2 names and terms from your materials/);
        const lines = readFileSync(text, 'utf8').split('\n');
        const materials = lines.findIndex((line) => /^Materials$/.test(line.trim()));
        // The disclosure triangle reads as "> " or "› " when it is read at all.
        const advanced = lines.findIndex((line) => /^([>›]\s*)?Advanced$/.test(line.trim()));
        assertEq(materials >= 0 && advanced > materials, true, `the materials come first, Advanced after them: ${JSON.stringify(lines)}`);
        assertNotContains(
            text,
            /^(Occasion|Language|Names and terms)$/,
            'everything else is folded away under Advanced, and there is no language to choose',
        );

        await cue.dashboardPage('Bee talk/answers', /How many hives did you study/);
        assertContains(text, /We studied 48 hives on 6 rooftops/);
        assertContains(text, /What were the winter losses/);
        assertContains(text, /From Your Files/);
        assertContains(text, /Prepared by Cue/);
        assertContains(text, /Do the bees bother the neighbours/, "and Cue's own");

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
    },
);
