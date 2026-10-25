import { assertContains, assertFile, assertNotContains, e2eCase, fail, fixture, ocr } from '../harness/index.ts';

e2eCase('`Cue --render` draws a notes file the way the app shows it.', async (cue) => {
    const png = cue.path('notes.png');
    const render = await cue.cli('--render', fixture('notes', 'sample.md'), png);
    if (render.code !== 0) fail(`--render exited with ${render.code}`, render.output);
    assertFile(png);
    const text = cue.save('notes.txt', await ocr(png));
    assertContains(text, /Weekly sync about the report/);
    assertContains(text, /^Summary$/);
    assertContains(text, /send the report/);
    assertContains(text, /^Transcript$/);
    assertContains(text, /00:00:12/);
    assertNotContains(text, /transcript -->/, 'the transcript marker must not be drawn');
});
