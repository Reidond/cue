import { assertContains, e2eCase, fail, fixture } from '../harness/index.ts';

e2eCase('Cue launches in the sandbox, reads its materials and shows the overlay on Start Cue.', async (cue) => {
    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png') });
    await cue.waitLog(/Materials .*talk\.md/, 30);
    // The old settings became "My project"; Start Cue shows the overlay for it.
    cue.control('start My project');
    // The status says "Starting speech recognition…" or "Warming up Claude…" until the live call is up on the backend (speech streams
    // open, Claude warmed). Vision runs its words together and misreads its first letters ("Startingispeec.."), so any piece of them
    // means it still does; none is anywhere on the settled overlay. A snapshot taken before the overlay is drawn reads as nothing, which
    // isn't settled either.
    let overlay = '';
    await cue.waitFor('the overlay to settle on its status', 120, async () => {
        overlay = await cue.snapshotText(cue.path('cue.png'));
        return /When someone asks a question/.test(overlay) && !/tarting|speec|arming/.test(overlay);
    });
    const text = cue.save('overlay.txt', overlay);
    assertContains(text, /When someone asks a question/, 'the overlay should show its ready state');
    // Vision misreads the status's first letters beside its warning sign ("A No audio", "SNa audiopeec..."), but only "No audio" of all
    // the statuses (AppState.status) says audio, and nothing else on the overlay does.
    assertContains(text, /audio/, 'with live audio off the status says so');
    if (!cue.alive()) fail('Cue quit on its own');
});
