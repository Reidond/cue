import { accountProject, assertEq, e2eCase, fixture, minutesFromNow, sleep, windowText } from '../harness/index.ts';

/** How many lines of the window's text are exactly this (a project's name: in the pane, and in the pickers). */
const lines = (text: string, name: string): number => text.split('\n').filter((line) => line === name).length;

e2eCase(
    'Cue for Windows: the project picked for a recurring meeting on Upcoming is remembered for its next occurrence, after a relaunch; the others go to Meetings.',
    async (cue) => {
        await accountProject(cue, 'Research', { materials: [fixture('materials', 'talk.md')] });
        cue.calendar([
            {
                id: 'weekly-1',
                series: 'weekly-sync',
                title: 'Weekly sync',
                recurring: true,
                start: minutesFromNow(30),
                end: minutesFromNow(60),
                url: 'https://meet.google.com/abc-defg-hij',
            },
            { title: 'Board meeting', start: minutesFromNow(90), end: minutesFromNow(120), url: 'https://acme.webex.com/meet/board' },
        ]);
        await cue.launch({ CUE_PROJECT: 'Research' });
        cue.control('page upcoming');
        await cue.waitFor('both calls to go to Meetings at first', 60, async () => {
            const text = await windowText(cue.pid);
            return /^Board meeting$/m.test(text) && lines(text, 'Meetings') === 2;
        });
        const before = lines(await windowText(cue.pid), 'Research');

        cue.control('assign Weekly sync | Research');
        await cue.waitFor('Weekly sync to go to Research', 30, async () => {
            const text = await windowText(cue.pid);
            return lines(text, 'Research') === before + 1;
        });
        assertEq(lines(await windowText(cue.pid), 'Meetings'), 1, 'Board meeting still goes to Meetings');

        await cue.stop();
        await sleep(1); // session logs are named by the second
        // The next occurrence of the series (another id, the same series), and a new one-off call.
        cue.calendar([
            {
                id: 'weekly-2',
                series: 'weekly-sync',
                title: 'Weekly sync',
                recurring: true,
                start: minutesFromNow(20),
                end: minutesFromNow(40),
                url: 'https://meet.google.com/abc-defg-hij',
            },
            { title: 'Kickoff', start: minutesFromNow(50), end: minutesFromNow(80), url: 'https://meet.google.com/kic-koff-now' },
        ]);
        await cue.launch({ CUE_PROJECT: 'Research' });
        cue.control('page upcoming');
        await cue.waitFor('the next Weekly sync to go to Research, and Kickoff to Meetings', 60, async () => {
            const text = await windowText(cue.pid);
            return /^Kickoff$/m.test(text) && lines(text, 'Research') === before + 1 && lines(text, 'Meetings') === 1;
        });
    },
);
