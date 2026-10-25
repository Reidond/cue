import { assertContains, e2eCase, fail, fixture } from '../harness/index.ts';

e2eCase('Cue launches in the sandbox, reads its materials and shows the overlay on Start Cue.', async (cue) => {
    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png') });
    await cue.waitLog(/Materials .*talk\.md/, 30);
    // The old settings became "My project"; Start Cue shows the overlay for it.
    cue.control('start My project');
    const text = cue.save('overlay.txt', await cue.snapshotText(cue.path('cue.png')));
    assertContains(text, /When someone asks a question/, 'the overlay should show its ready state');
    assertContains(text, /^No audio$/, 'with live audio off the status says so');
    if (!cue.alive()) fail('Cue quit on its own');
});
