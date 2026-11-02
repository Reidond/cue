import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    accountProject,
    assertTextContains,
    assertTextNotContains,
    e2eCase,
    exec,
    fixture,
    minutesFromNow,
    press,
    skip,
    windowText,
} from '../harness/index.ts';
import { E2E_ROOT } from '../harness/config.ts';

/** Runs tools/appointments.ps1: what Windows' appointment store holds is what Cue for Windows reads. */
async function appointments(action: 'add' | 'remove', file?: string): Promise<string> {
    const ran = await exec('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        join(E2E_ROOT, 'tools', 'appointments.ps1'),
        action,
        ...(file ? [file] : []),
    ]);
    return ran.stdout.trim();
}

e2eCase(
    'Cue for Windows: the calls on Upcoming can come from Windows’ own appointment store (no file standing in for it): an appointment with a call link, ' +
        'and each day of a recurring one, are listed; Settings › Calendar lists the calendar, and its switch takes its calls out.',
    async (cue) => {
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        const file = cue.path('appointments.json');
        writeFileSync(
            file,
            JSON.stringify([
                { subject: 'Store call', start: minutesFromNow(30), minutes: 30, location: 'https://meet.google.com/abc-defg-hij' },
                { subject: 'Store lunch', start: minutesFromNow(60), minutes: 30, location: 'Café on the corner' },
                {
                    subject: 'Daily store sync',
                    start: minutesFromNow(90),
                    minutes: 15,
                    details: 'Join https://us02web.zoom.us/j/123456789 please',
                    daily: true,
                },
            ]),
        );
        const added = await appointments('add', file);
        try {
            if (added !== 'ok') skip(`this PC has no calendar service to put appointments in (${added})`);
            // CUE_CALENDAR_EVENTS empty: not the test file, Windows' own store.
            await cue.launch({ CUE_PROJECT: 'Bees', CUE_CALENDAR_EVENTS: '' });
            cue.control('page upcoming');
            await cue.waitFor('the store’s calls on Upcoming', 60, async () => /^Store call$/m.test(await windowText(cue.pid)));
            const page = await windowText(cue.pid);
            cue.save('upcoming.txt', page);
            assertTextContains(page, /^Daily store sync$/, 'a recurring appointment is listed');
            assertTextContains(page, /^Google Meet$/);
            assertTextContains(page, /^Zoom$/, 'the link in the details counts');
            assertTextNotContains(page, /Store lunch/, 'an appointment without a call link is not a call');

            // Settings › Calendar lists the calendar; switching it off takes its calls away.
            cue.control('settings calendar');
            await cue.waitFor('the calendar in Settings', 30, async () => /^Watch Cue e2e$/m.test(await windowText(cue.pid)));
            await press(cue.pid, 'Watch Cue e2e');
            cue.control('page upcoming');
            await cue.waitFor('its calls to go', 60, async () => !/^Store call$/m.test(await windowText(cue.pid)));
        } finally {
            await appointments('remove');
        }
    },
);
