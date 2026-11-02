import { assertNotContains, assertTextContains, e2eCase, minutesFromNow, sleep, windowText } from '../harness/index.ts';

e2eCase(
    'Cue for Windows: with “Do nothing” Cue lists the call but never asks or records, even with call apps on the microphone.',
    async (cue) => {
        cue.calendar([
            {
                title: 'Weekly design sync',
                start: minutesFromNow(-2),
                end: minutesFromNow(30),
                url: 'https://meet.google.com/abc-defg-hij',
            },
        ]);
        await cue.defaults('meetingAction', 'nothing');
        cue.micApps('chrome.exe', 'zoom.exe');
        await cue.launch({ CUE_MEETING_TICK: '0.5', CUE_MIC_RELEASE: '2' });

        cue.control('page upcoming');
        await cue.waitFor('the call on Upcoming', 60, async () => /^Weekly design sync$/m.test(await windowText(cue.pid)));
        assertTextContains(await windowText(cue.pid), /doesn.t record calls when they start/);
        await sleep(3);
        const log = cue.sessionLog();
        assertNotContains(log, /🔔/);
        assertNotContains(log, /📅 Recording/);
    },
);
