import { assertContains, e2eCase, needOverlaySnapshots } from '../harness/index.ts';

const OWNER = 'owner@cue.test';

e2eCase('At the plan limit the overlay says so plainly where it says what Cue is doing.', async (cue) => {
    needOverlaySnapshots();
    const backend = await cue.backend({ adminEmails: [OWNER] });
    await cue.project('Bees', { language: 'en' });
    await cue.launch({ CUE_PROJECT: 'Bees', CUE_ME_TICK: '1', CUE_SNAPSHOT: cue.path('cue.png') });
    await backend.setLimit(OWNER, cue.email, 5);
    await backend.seedUsage(cue.email, [{ feature: 'answer', usd: 5 }]);
    await cue.waitLog(/⚠︎ Cue plan limit reached: /, 60);
    cue.control('start Bees');
    let shown = '';
    await cue.waitFor('the overlay to say the limit is reached', 60, async () => {
        shown = await cue.snapshotText(cue.path('cue.png'));
        return /plan limit/i.test(shown);
    });
    assertContains(cue.save('overlay.txt', shown), /plan limit/i);
});
