import {
    accountProject,
    assertTextContains,
    bursts,
    controlsOf,
    e2eCase,
    fail,
    fixture,
    needOverlaySnapshots,
    needWindowsOcr,
    ocr,
    sleep,
    windowsOf,
    windowText,
    type Control,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: at its default size the overlay’s bar has room for all of it while a recording runs (the whole status beside the timer, with a project ' +
        'name as long as a person’s), and the project, the status, the timer and the switches sit on one middle line, side by side.',
    async (cue) => {
        await needWindowsOcr();
        await accountProject(cue, 'Rooftop Hives', { materials: [fixture('materials', 'talk.md')] });
        // A quiet call, long enough for the case: the rehearsal starts Cue, and the status says it is listening.
        const call = await bursts(cue.path('call.wav'), 120, []);
        await cue.launch({ CUE_PROJECT: 'Rooftop Hives', CUE_REHEARSE_PARTICIPANT: call, CUE_SNAPSHOT: cue.path('cue.png') });
        await cue.waitLog(/📞 Live call started/, 60);
        await cue.waitFor('the status line', 60, async () => /^Listening$/m.test(await windowText(cue.pid)));

        // A recording puts its timer in the bar: the most the bar ever holds.
        cue.control('record');
        await cue.waitLog(/⏺ Recording started \(overlay\)/, 20);
        await cue.waitFor('the timer', 20, async () => /^0:[0-5][0-9]$/m.test(await windowText(cue.pid)));
        assertTextContains(await windowText(cue.pid), /^Auto$/, 'Auto, named so whether its label shows or not');

        // One middle line, in order, none over the next (a status cut off by the bar's edge ran under the timer).
        const controls = await controlsOf(cue.pid, 'Cue overlay');
        const dump = JSON.stringify(controls, null, 2);
        cue.save('overlay-controls.json', dump);
        const middle = (control: Control) => control.top + control.height / 2;
        const project = controls.find((control) => control.name === 'Project') ?? fail('no project in the overlay’s bar', dump);
        // In the bar, not further down ("Listening" is also the empty list's heading): a status with no room at all has no box there.
        const inBar = (name: string): Control =>
            controls.find((control) => control.name === name && control.top < project.top + project.height) ??
            fail(`“${name}” should be in the overlay’s bar (one with no room has no box there)`, dump);
        const row = [project, ...['Listening', 'Recording', 'Auto', 'Transcript', 'Settings'].map(inBar)];
        for (const [index, control] of row.entries()) {
            if (Math.abs(middle(control) - middle(project)) > 2)
                fail(
                    `“${control.name}” should be on the bar’s middle line: its middle is at ${middle(control)} px, the project’s at ${middle(project)} px`,
                    dump,
                );
            const before = row[index - 1];
            if (before && control.left < before.left + before.width)
                fail(
                    `“${control.name}” (from ${control.left} px) should come after “${before.name}” (to ${before.left + before.width} px)`,
                    dump,
                );
        }

        // And the snapshot shows the whole status, neither cut off nor shortened to “…”: read in the bar alone, as the empty list below it has a
        // “Listening” heading of its own. The snapshot is the window's own pixels, so the bar is where UI Automation has it, less the window's corner.
        needOverlaySnapshots();
        const overlay = (await windowsOf(cue.pid)).windows.find((window) => window.title === 'Cue overlay') ?? fail('no overlay window');
        const bar = { left: 0, top: project.top - overlay.top - 8, width: overlay.width, height: project.height + 16 };
        await cue.waitFor('the project and the whole status in the snapshot’s bar', 30, async () => {
            // A snapshot taken since the timer showed (one every 2 s).
            await sleep(2.5);
            const text = await ocr(cue.path('cue.png'), bar);
            cue.save('overlay-bar.txt', text);
            return /\bRooftop Hives\b/.test(text) && /\bListening\b/.test(text);
        });
    },
);
