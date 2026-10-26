import {
    assertContains, assertEq, assertNotContains, countLines, e2eCase, minutesFromNow, tomorrowAt,
} from '../harness/index.ts';

e2eCase("Upcoming lists today's and tomorrow's calls with a Meet / Zoom / Teams link from the watched calendars, each "
    + 'with the project its notes go to; Settings shows the calendar choices.', async (cue) => {
    cue.calendar([
        {
            title: 'Design review', start: minutesFromNow(60), end: minutesFromNow(90), calendar: 'Work',
            url: 'https://meet.google.com/abc-defg-hij', attendees: ['Olena Mulesa', 'Petro Ivanenko'],
        },
        {
            title: 'Lunch with Ira', start: minutesFromNow(90), end: minutesFromNow(150), calendar: 'Work',
            location: 'Café on the corner',
        },
        {
            title: 'Teams planning', start: minutesFromNow(120), end: minutesFromNow(180), calendar: 'Work',
            notes: 'Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0 — agenda to follow',
        },
        {
            title: 'Zoom standup', start: tomorrowAt('10:00'), end: tomorrowAt('10:15'), calendar: 'Work',
            location: 'https://us02web.zoom.us/j/123456789?pwd=abc', recurring: true,
        },
        {
            title: 'Family call', start: minutesFromNow(30), end: minutesFromNow(60), calendar: 'Personal',
            url: 'https://meet.google.com/xyz-abcd-efg',
        },
        {
            title: 'Old retro', start: minutesFromNow(-2880), end: minutesFromNow(-2820), calendar: 'Work',
            url: 'https://meet.google.com/old-retr-ooo',
        },
    ]);
    await cue.defaults('unwatchedCalendars', ['Personal']);
    await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png'), CUE_SHOW_SETTINGS: '1' });
    const text = cue.page;

    await cue.dashboardPage('upcoming', /Design review/);
    assertContains(text, /Teams planning/);
    assertContains(text, /Zoom standup/);
    assertContains(text, /^Tomorrow$/);
    assertContains(text, /Google Meet/);
    assertContains(text, /Microsoft Teams/);
    assertContains(text, /Olena Mulesa, Petro Ivanenko/);
    assertNotContains(text, /Lunch with Ira/, 'an event without a call link is not a call');
    assertNotContains(text, /Family call/, 'events in unwatched calendars are left out');
    assertNotContains(text, /Old retro/, "only today's and tomorrow's calls are listed");
    // No project is assigned yet, so every call goes to Meetings (which doesn't exist until the first recording).
    assertEq(countLines(text, /Meetings/), 3, 'each of the three calls should show Meetings as its project');
    assertContains(text, /Cue asks whether to record it/);

    // Settings › Calendar: what Cue does when a meeting starts, and the calendars it looks in.
    cue.control('settings calendar');
    let calendar = '';
    await cue.waitFor('Settings › Calendar', 20, async () => /When a meeting starts/.test(calendar = await cue.snapshotText(cue.path('cue-settings.png'))));
    const settings = cue.save('settings.txt', calendar);
    assertContains(settings, /When a meeting starts/);
    assertContains(settings, /^Ask/);
    assertContains(settings, /Work$/);
    assertContains(settings, /Personal$/);
});
