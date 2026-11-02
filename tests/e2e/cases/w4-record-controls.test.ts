import {
    accountProject,
    assertContains,
    assertEq,
    assertTextContains,
    click,
    e2eCase,
    fixture,
    needInteractiveDesktop,
    press,
    pressKeys,
    windowText,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: Win+Alt+C starts and stops a recording from any program, the overlay’s Record button starts one and its timer’s menu has Stop Recording; ' +
        'the log says what started and stopped each, and a recording with nothing said saves no notes and tells why.',
    async (cue) => {
        await needInteractiveDesktop();
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        // CUE_SURFACES: a test run has no hot keys; this case is about them.
        await cue.launch({ CUE_PROJECT: 'Bees', CUE_SURFACES: '1' });
        cue.control('start Bees');
        await cue.waitFor('the overlay’s bar', 60, async () => /^Record$/m.test(await windowText(cue.pid)));
        assertEq(cue.logCount(/Couldn't register the shortcut for Start or Stop Recording/), 0, 'Win+Alt+C should be Cue’s');

        // The shortcut starts it, and the overlay's button turns into the timer.
        await pressKeys('win', 'alt', 'c');
        await cue.waitLog(/⏺ Recording started \(Win\+Alt\+C\)/, 20);
        await cue.waitFor('the timer', 20, async () => /^0:[0-5][0-9]$/m.test(await windowText(cue.pid)));
        assertTextContains(await windowText(cue.pid), /^Recording$/, 'the timer’s button');

        // Its menu has Stop Recording.
        await press(cue.pid, 'Recording');
        await cue.waitFor('the menu', 20, async () => /^Stop Recording$/m.test(await windowText(cue.pid)));
        await press(cue.pid, 'Stop Recording');
        await cue.waitLog(/⏹ Recording stopped after 0:[0-5][0-9] \(overlay\)/, 20);
        // Nothing was said: no notes, and the person is told why.
        await cue.waitLog(/⚠︎ Nothing was recorded: Cue didn't hear any speech while recording, so no notes were saved\./, 30);
        assertEq(cue.findNotes().length, 0, 'no notes were saved');
        await cue.waitFor('the Record button again', 20, async () => /^Record$/m.test(await windowText(cue.pid)));

        // The Record button itself (a real click) starts one; the shortcut stops it.
        await click(cue.pid, 'Record');
        await cue.waitLog(/⏺ Recording started \(overlay\)/, 20);
        await pressKeys('win', 'alt', 'c');
        await cue.waitLog(/⏹ Recording stopped after 0:[0-5][0-9] \(Win\+Alt\+C\)/, 20);
        await cue.waitFor('both to have been told', 30, () => cue.logCount(/Nothing was recorded/) === 2);
        assertContains(cue.sessionLog(), /🎤 Listening/, 'recording opened the audio as Cue does');
    },
);
