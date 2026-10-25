import { assertEq, assertNotContains, e2eCase, minutesFromNow, sleep } from '../harness/index.ts';

e2eCase("A call in the calendar plus a browser on the microphone brings one Record prompt; after Not now Cue doesn't "
    + "ask again about that meeting. Calls without a link, or over, don't count.", async (cue) => {
    cue.calendar([
        { title: 'Lunch with Ira', start: minutesFromNow(-10), end: minutesFromNow(40), location: 'Café on the corner' },
        { title: 'Old standup', start: minutesFromNow(-60), end: minutesFromNow(-1), url: 'https://meet.google.com/old-stan-dup' },
        {
            title: 'Weekly design sync', start: minutesFromNow(3), end: minutesFromNow(45),
            url: 'https://meet.google.com/abc-defg-hij', attendees: ['Olena Mulesa'],
        },
    ]);
    await cue.launch({ CUE_MEETING_TICK: '0.5', CUE_MIC_RELEASE: '2' });

    await sleep(2);
    assertNotContains(cue.sessionLog(), /🔔/, 'nothing to ask while no call app uses the microphone');

    // Chrome joins the call (its helper process opens the microphone); the meeting starts in 3 minutes.
    cue.micApps('com.google.Chrome.helper');
    await cue.waitLog(/🔔 Record “Weekly design sync”\?/, 10);
    await sleep(2);
    assertEq(cue.logCount(/🔔 Record/), 1, 'one prompt while it waits for an answer');

    cue.control('notification dismiss');
    await cue.waitLog(/🔔 Not now: “Weekly design sync”/, 5);
    await sleep(2);
    // Leaving and rejoining the same meeting doesn't bring the prompt back either.
    cue.micApps();
    await sleep(3);
    cue.micApps('com.google.Chrome.helper');
    await sleep(2);
    assertEq(cue.logCount(/🔔 Record/), 1, "after Not now Cue doesn't ask about the same meeting again");
    const log = cue.sessionLog();
    assertNotContains(log, /📅 Recording/);
    assertNotContains(log, /Lunch with Ira|Old standup/);
});
