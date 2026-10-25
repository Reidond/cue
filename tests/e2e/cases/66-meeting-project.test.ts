import { assertContains, assertEq, countLines, e2eCase, minutesFromNow, sleep } from '../harness/index.ts';

e2eCase('The project picked for a recurring meeting on Upcoming is remembered for its next occurrence, after '
    + 'relaunch.', async (cue) => {
    await cue.project('Research', { language: 'en' });
    const text = cue.page;

    cue.calendar([
        {
            id: 'weekly-1', series: 'weekly-sync', title: 'Weekly sync', recurring: true,
            start: minutesFromNow(30), end: minutesFromNow(60), url: 'https://meet.google.com/abc-defg-hij',
        },
        { title: 'Board meeting', start: minutesFromNow(90), end: minutesFromNow(120), url: 'https://acme.webex.com/meet/board' },
    ]);
    await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png') });
    await cue.dashboardPage('upcoming', /Board meeting/);
    assertEq(countLines(text, /Meetings/), 2, 'both calls go to Meetings at first');
    cue.control('assign Weekly sync | Research');
    // The sidebar lists Research; the meeting's picker shows it too.
    await cue.waitFor('Weekly sync to go to Research', 20,
        async () => (await cue.dashboardShows(/Board meeting/)) && countLines(text, /Research/) === 2);
    assertEq(countLines(text, /Meetings/), 1, 'Board meeting still goes to Meetings');

    await cue.stop();
    await sleep(1); // session logs are named by the second
    // The next occurrence of the series (another id, the same series), and a new one-off call.
    cue.calendar([
        {
            id: 'weekly-2', series: 'weekly-sync', title: 'Weekly sync', recurring: true,
            start: minutesFromNow(20), end: minutesFromNow(40), url: 'https://meet.google.com/abc-defg-hij',
        },
        { title: 'Kickoff', start: minutesFromNow(50), end: minutesFromNow(80), url: 'https://meet.google.com/kic-koff-now' },
    ]);
    await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png') });
    await cue.dashboardPage('upcoming', /Kickoff/);
    assertContains(text, /Weekly sync/);
    assertEq(countLines(text, /Research/), 2, 'the next Weekly sync should still go to Research');
    assertEq(countLines(text, /Meetings/), 1, 'a new call goes to Meetings');
});
