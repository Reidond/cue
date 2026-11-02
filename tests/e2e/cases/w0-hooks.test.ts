import {
    assertBetween,
    assertContains,
    assertEq,
    assertTextContains,
    e2eCase,
    exec,
    needWindowsOcr,
    nonEmpty,
    windowText,
    windowsOf,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: CUE_BACKGROUND keeps its window out of the way, CUE_SNAPSHOT writes it, CUE_APPEARANCE picks the theme, CUE_SHOW_SETTINGS opens Settings, and `size` resizes the window.',
    async (cue) => {
        await needWindowsOcr();
        const snapshot = cue.path('cue-dashboard.png');
        await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png'), CUE_APPEARANCE: 'dark', CUE_SHOW_SETTINGS: '1' }, { signIn: false });

        // The windows: shown, behind everything, with no taskbar button, and the focus never taken.
        await cue.waitFor('the window', 30, async () => (await windowsOf(cue.pid)).windows.length > 0);
        const seen = await windowsOf(cue.pid);
        assertEq(seen.foreground, false, 'Cue never takes the focus');
        assertEq(seen.windows.length, 1, 'one window: the dashboard');
        assertEq(seen.windows[0]?.toolWindow, true, 'no taskbar button');
        assertEq(seen.windows[0]?.noActivate, true, 'a click does not bring it forward');

        // CUE_SHOW_SETTINGS: Settings is open (the text of the window as UI Automation reads it: what the window shows even when Windows is not drawing it).
        const settings = await windowText(cue.pid);
        assertTextContains(settings, /^Settings$/);
        assertTextContains(settings, /^Your name$/);

        // The snapshot, in the dark theme.
        await cue.waitLog(/📸 Snapshots: window capture \(PrintWindow\), in the dark appearance/, 30);
        await cue.waitFor('the snapshot', 60, () => nonEmpty(snapshot));
        const text = cue.save('dashboard.txt', await cue.snapshotText(snapshot));
        assertContains(text, /Settings/);
        assertContains(text, /Your name/);
        const pixel = await exec('powershell.exe', [
            '-NoProfile',
            '-Command',
            `Add-Type -AssemblyName System.Drawing; $b = [System.Drawing.Bitmap]::FromFile('${snapshot}'); $c = $b.GetPixel([int]($b.Width * 0.8), [int]($b.Height * 0.5)); $b.Dispose(); [int](($c.R + $c.G + $c.B) / 3)`,
        ]);
        assertBetween(Number(pixel.stdout.trim()), 0, 90, 'the dark theme: the page behind the settings is dark');

        // `size W H`: the window's edge dragged (to sizes any screen has room for: a window can't be larger than it).
        const extent = async (): Promise<{ width: number; height: number }> => {
            const window = (await windowsOf(cue.pid)).windows[0];
            return { width: window?.width ?? 0, height: window?.height ?? 0 };
        };
        const sized = async (width: number, height: number): Promise<{ width: number; height: number }> => {
            const start = await extent();
            cue.control(`size ${width} ${height}`);
            let last = start;
            // Changed from what it was, and the same twice in a row.
            await cue.waitFor(`the window to be ${width} × ${height} points`, 30, async () => {
                const now = await extent();
                const settled =
                    now.width === last.width && now.height === last.height && (now.width !== start.width || now.height !== start.height);
                last = now;
                return settled;
            });
            return last;
        };
        const large = await sized(1000, 640);
        const small = await sized(800, 560);
        assertBetween(large.width / small.width, 1.15, 1.3, 'the width went from 1000 to 800 points');
        assertBetween(large.height / small.height, 1.08, 1.2, 'the height went from 640 to 560 points');

        // Signed out, the other pages ask to sign in.
        cue.control('page upcoming');
        await cue.waitFor('Upcoming to ask for a sign-in', 30, async () => /^Sign in to Cue$/m.test(await windowText(cue.pid)));
    },
);
