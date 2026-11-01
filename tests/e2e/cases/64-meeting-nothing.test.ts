import { assertContains, assertNotContains, e2eCase, minutesFromNow, sleep } from '../harness/index.ts';

e2eCase('With "Do nothing" Cue lists the call but never asks or records, even with call apps on the microphone.', async (cue) => {
    cue.calendar([
        {
            title: 'Weekly design sync',
            start: minutesFromNow(-2),
            end: minutesFromNow(30),
            url: 'https://meet.google.com/abc-defg-hij',
        },
    ]);
    await cue.defaults('meetingAction', 'nothing');
    cue.micApps('com.google.Chrome.helper', 'us.zoom.xos');
    await cue.launch({ CUE_MEETING_TICK: '0.5', CUE_MIC_RELEASE: '2', CUE_SNAPSHOT: cue.path('cue.png') });

    await cue.dashboardPage('upcoming', /Weekly design sync/);
    assertContains(cue.page, /doesn.t record calls when they start/);
    await sleep(3);
    const log = cue.sessionLog();
    assertNotContains(log, /🔔/);
    assertNotContains(log, /📅 Recording/);
});
