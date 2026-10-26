import { assertContains, e2eCase, fixture } from '../harness/index.ts';

e2eCase('The session log says what started and what stopped a recording, and after how long.', async (cue) => {
    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.launch();
    await cue.waitLog(/Materials .*talk\.md/, 30);
    cue.control('start My project');

    cue.control('record');
    await cue.waitLog(/⏺ Recording started \(overlay\)/, 20);
    cue.control('record');
    await cue.waitLog(/⏹ Recording stopped after 0:0[0-9] \(overlay\)/, 20);
    // Nobody spoke, so there are no notes; the alert says so in the log.
    await cue.waitLog(/Nothing was recorded/, 20);
    assertContains(cue.sessionLog(), /⏺ Recording started \(overlay\)/);
});
