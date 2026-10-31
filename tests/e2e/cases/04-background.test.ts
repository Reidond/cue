import { appWindows, e2eCase, exists, fail, silence, type AppWindows } from '../harness/index.ts';

e2eCase(
    'A test run stays out of the way: Cue never takes focus or shows a Dock icon, its windows stay behind everyone ' +
        "else's, and an alert goes to the session log instead of waiting for a click.",
    async (cue) => {
        // A rehearsal shows the overlay at launch; recorded, a silent one ends in "Nothing was recorded".
        const call = await silence(cue.path('silence.wav'), 3);
        await cue.launch({ CUE_SHOW_SETTINGS: '1', CUE_REHEARSE_RECORD: '1', CUE_REHEARSE_PARTICIPANT: call });
        const seen: AppWindows[] = [];
        const look = async (): Promise<void> => {
            seen.push(await appWindows(cue.pid));
        };
        // Looked at every half second while the dashboard, Settings and the overlay open and the recording ends.
        await cue.waitFor('the alert in the session log', 60, async () => {
            await look();
            return cue.logCount(/⚠︎ Nothing was recorded: Cue didn't hear any speech/) > 0;
        });
        // The alert didn't hold Cue up: it still does what it's told.
        cue.control('new After the alert');
        await cue.waitFor('the project made after the alert', 10, async () => {
            await look();
            return exists(cue.projectPath('After the alert'));
        });

        const dump = (what: AppWindows): string => JSON.stringify(what, null, 2);
        for (const what of seen) {
            if (what.active || what.frontmost?.pid === cue.pid) fail('Cue took focus', dump(what));
            if (what.policy === 'regular') fail('Cue showed a Dock icon', dump(what));
            if (what.windows.some((window) => window.level >= what.levels.desktopIcons)) {
                fail('a Cue window came up among the windows of the apps in use, not behind them', dump(what));
            }
        }
        const most = Math.max(...seen.map((what) => what.windows.length));
        if (most < 3)
            fail(
                `the dashboard, Settings and the overlay should all be on screen, behind everything; at most ${most} were`,
                dump(seen.at(-1)!),
            );
    },
);
