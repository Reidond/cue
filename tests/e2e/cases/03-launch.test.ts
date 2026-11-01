import { assertContains, e2eCase, fail, fixture } from '../harness/index.ts';

e2eCase('Cue launches in the sandbox, reads its materials and shows the overlay on Start Cue.', async (cue) => {
    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png') });
    await cue.waitLog(/Materials .*talk\.md/, 30);
    // The old settings became "My project"; Start Cue shows the overlay for it.
    cue.control('start My project');
    // The status says "Starting speech recognition…" until the live call is up on the backend (Claude warmed, speech streams open).
    let overlay = '';
    await cue.waitFor('the overlay to settle on its status', 120, async () => {
        overlay = await cue.snapshotText(cue.path('cue.png'));
        return !/Starting spee/.test(overlay);
    });
    const text = cue.save('overlay.txt', overlay);
    assertContains(text, /When someone asks a question/, 'the overlay should show its ready state');
    // The status follows its warning sign, which Vision may read as a letter ("A No audio"), and may run into what is beside it ("No audiopeec...").
    assertContains(text, /(^|\s)No audio/, 'with live audio off the status says so');
    if (!cue.alive()) fail('Cue quit on its own');
});
