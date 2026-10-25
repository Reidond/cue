import { assertContains, assertNotContains, Cue, e2eCase } from '../harness/index.ts';

e2eCase('Kept behind every other window, the dashboard, Settings and the overlay still snapshot, each one alone — '
    + 'even with the windows of a Cue from another checkout down there too.', async (cue) => {
    await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png'), CUE_SHOW_SETTINGS: '1' });
    cue.control('new Behind');
    cue.control('start Behind');
    await cue.waitLog(/🎤 Listening/, 20);
    // Another checkout's case: its dashboard and overlay open where these do, in front of them at the same level.
    const other = await Cue.open('05-other-checkout');
    try {
        await other.launch();
        other.control('new Elsewhere');
        other.control('start Elsewhere');
        await other.waitLog(/🎤 Listening/, 20);
        // They overlap where they open; what only one of them shows tells them apart.
        const dashboard = cue.save('dashboard.txt', await cue.snapshotText(cue.path('cue-dashboard.png')));
        const settings = cue.save('settings.txt', await cue.snapshotText(cue.path('cue-settings.png')));
        const overlay = cue.save('overlay.txt', await cue.snapshotText(cue.path('cue.png')));
        const shows = {
            dashboard: /New Project|About the Talk/, settings: /Answer questions automatically|Your name/, overlay: /Ask anything/,
            other: /Elsewhere/,
        };

        assertContains(dashboard, shows.dashboard, 'the dashboard snapshot should show the dashboard');
        assertNotContains(dashboard, shows.settings, 'Settings, which opens over the dashboard, should be left out of its snapshot');
        assertNotContains(dashboard, shows.overlay, 'the overlay, which opens over the dashboard, should be left out of its snapshot');
        assertContains(settings, shows.settings, 'the Settings snapshot should show Settings');
        assertNotContains(settings, shows.dashboard, 'the dashboards should be left out of the Settings snapshot');
        assertNotContains(settings, shows.overlay, 'the overlays should be left out of the Settings snapshot');
        assertContains(overlay, shows.overlay, 'the overlay snapshot should show the overlay');
        assertNotContains(overlay, shows.dashboard, 'the dashboards should be left out of the overlay snapshot');
        assertNotContains(overlay, shows.settings, 'Settings should be left out of the overlay snapshot');
        for (const [name, text] of [['dashboard', dashboard], ['Settings', settings], ['overlay', overlay]] as const) {
            assertNotContains(text, shows.other, `the other checkout's windows should be left out of the ${name} snapshot`);
        }
    } finally {
        await other.close(true);
    }
});
