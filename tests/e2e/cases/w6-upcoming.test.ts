import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    accountProject,
    assertEq,
    assertTextContains,
    assertTextNotContains,
    clearOfMidnight,
    e2eCase,
    fixture,
    minutesFromNow,
    press,
    tomorrowAt,
    windowText,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: Upcoming lists today’s and tomorrow’s calls with a Meet / Zoom / Teams link from the watched calendars, each with the project its notes ' +
        'go to; Settings › Calendar shows what Cue does when a call starts and the calendars it looks in, and a switch brings a calendar’s calls in.',
    async (cue) => {
        // Tomorrow's call must still be tomorrow's when the page is read (a run at 23:59 once read it after midnight, as today's).
        await clearOfMidnight(10);
        cue.calendar([
            {
                title: 'Design review',
                start: minutesFromNow(60),
                end: minutesFromNow(90),
                calendar: 'Work',
                url: 'https://meet.google.com/abc-defg-hij',
                attendees: ['Olena Mulesa', 'Petro Ivanenko'],
            },
            {
                title: 'Lunch with Ira',
                start: minutesFromNow(90),
                end: minutesFromNow(150),
                calendar: 'Work',
                location: 'Café on the corner',
            },
            {
                title: 'Teams planning',
                start: minutesFromNow(120),
                end: minutesFromNow(180),
                calendar: 'Work',
                notes: 'Join: https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0 — agenda to follow',
            },
            {
                title: 'Zoom standup',
                start: tomorrowAt('10:00'),
                end: tomorrowAt('10:15'),
                calendar: 'Work',
                location: 'https://us02web.zoom.us/j/123456789?pwd=abc',
                recurring: true,
            },
            {
                title: 'Family call',
                start: minutesFromNow(30),
                end: minutesFromNow(60),
                calendar: 'Personal',
                url: 'https://meet.google.com/xyz-abcd-efg',
            },
            {
                title: 'Old retro',
                start: minutesFromNow(-2880),
                end: minutesFromNow(-2820),
                calendar: 'Work',
                url: 'https://meet.google.com/old-retr-ooo',
            },
        ]);
        await cue.defaults('unwatchedCalendars', ['Personal']);
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        await cue.launch({ CUE_PROJECT: 'Bees' });

        cue.control('page upcoming');
        await cue.waitFor('the calls on Upcoming', 60, async () => /^Design review$/m.test(await windowText(cue.pid)));
        let page = await windowText(cue.pid);
        cue.save('upcoming.txt', page);
        assertTextContains(page, /^Teams planning$/);
        assertTextContains(page, /^Zoom standup$/);
        assertTextContains(page, /^Tomorrow$/);
        assertTextContains(page, /^Google Meet$/);
        assertTextContains(page, /^Microsoft Teams$/);
        assertTextContains(page, /^Zoom$/);
        assertTextContains(page, /^Olena Mulesa, Petro Ivanenko$/);
        assertTextNotContains(page, /Lunch with Ira/, 'an event without a call link is not a call');
        assertTextNotContains(page, /Family call/, 'events in unwatched calendars are left out');
        assertTextNotContains(page, /Old retro/, 'only today’s and tomorrow’s calls are listed');
        // No project is picked yet, so every call goes to Meetings (which doesn't exist until the first recording): each picker says so.
        assertEq(
            page.split('\n').filter((line) => line === 'Meetings').length,
            3,
            'each of the three calls should show Meetings as its project',
        );
        assertTextContains(page, /Cue asks whether to record it/);

        // Home lists the next calls too.
        cue.control('page home');
        await cue.waitFor('Home to list the calls', 30, async () => /^Upcoming Calls$/m.test(await windowText(cue.pid)));
        assertTextContains(await windowText(cue.pid), /^Upcoming call: Design review$/);

        // Settings › Calendar: what Cue does when a call starts, and the calendars it looks in.
        cue.control('settings calendar');
        await cue.waitFor('Settings › Calendar', 30, async () => /^Watch Personal$/m.test(await windowText(cue.pid)));
        page = await windowText(cue.pid);
        assertTextContains(page, /^When a meeting starts$/);
        assertTextContains(page, /^Ask$/);
        assertTextContains(page, /^Work$/);
        assertTextContains(page, /^Personal$/);

        // Switching Personal on brings its call in, and the choice is kept.
        await press(cue.pid, 'Watch Personal');
        const settings = (): { unwatchedCalendars?: string[] } =>
            JSON.parse(readFileSync(join(cue.support, 'settings.json'), 'utf8')) as { unwatchedCalendars?: string[] };
        await cue.waitFor('Personal to be watched', 20, () => (settings().unwatchedCalendars ?? []).length === 0);
        cue.control('page upcoming');
        await cue.waitFor('the Family call', 60, async () => /^Family call$/m.test(await windowText(cue.pid)));
    },
);
