import { assertEq, assertNotContains, e2eCase, sleep } from '../harness/index.ts';

e2eCase(
    "A Zoom call that isn't in the calendar is offered for recording too (a browser alone isn't); if nothing is " +
        'said, no note is written, and the next Zoom call is offered again.',
    async (cue) => {
        await cue.launch({ CUE_MEETING_TICK: '0.5', CUE_MIC_RELEASE: '2' });

        cue.micApps('com.google.Chrome.helper');
        await sleep(2);
        assertNotContains(cue.sessionLog(), /🔔/, "a browser on the microphone without a meeting isn't a call");

        cue.micApps('com.google.Chrome.helper', 'us.zoom.xos');
        await cue.waitLog(/🔔 Record “Zoom call”\?/, 10);
        cue.control('notification record');
        await cue.waitLog(/📅 Recording “Zoom call” into Meetings/, 10);

        cue.micApps();
        await cue.waitLog(/📅 Zoom let go of the microphone/, 10);
        await cue.waitLog(/🔔 Nothing was recorded in “Zoom call”/, 10);
        assertEq(cue.findNotes().length, 0, 'no speech, no notes');

        cue.micApps('us.zoom.xos');
        await cue.waitFor('the next Zoom call to be offered', 15, () => cue.logCount(/🔔 Record “Zoom call”/) === 2);
    },
);
