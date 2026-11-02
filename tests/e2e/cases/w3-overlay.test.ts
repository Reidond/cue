import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    accountProject,
    assertContains,
    assertEq,
    assertNotContains,
    assertTextContains,
    captureScreen,
    click,
    e2eCase,
    fail,
    fixture,
    needInteractiveDesktop,
    needWindowsOcr,
    ocr,
    typeText,
    windowsOf,
    windowText,
    pressKeys,
} from '../harness/index.ts';
import { E2E_ROOT } from '../harness/config.ts';

const EXCLUDED = 0x11; // WDA_EXCLUDEFROMCAPTURE

e2eCase(
    'Cue for Windows: the overlay floats above another program’s window without taking the focus (a click on it too), is hidden from screen captures ' +
        '(unless CUE_ALLOW_CAPTURE), and typing into Ask is the one time it takes the keyboard, giving it back after.',
    async (cue) => {
        await needInteractiveDesktop();
        await needWindowsOcr();
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        // CUE_SURFACES: a test run keeps the overlay behind everything; this case is about the overlay in its real place.
        await cue.launch({ CUE_PROJECT: 'Bees', CUE_SURFACES: '1', FAKE_CLAUDE_ANSWER: 'Hello to you too.\n- A point' });

        // Another program's window has the focus.
        const blocker = spawn(
            'powershell.exe',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(E2E_ROOT, 'tools', 'blocker.ps1')],
            {
                stdio: 'ignore',
            },
        );
        try {
            const blockerPid = blocker.pid ?? fail('the other window did not start');
            await cue.waitFor('the other window to have the focus', 60, async () => (await windowsOf(blockerPid)).foreground);

            cue.control('start Bees');
            const overlayOf = async () => (await windowsOf(cue.pid)).windows.find((window) => window.title === 'Cue overlay');
            await cue.waitFor('the overlay', 30, async () => (await overlayOf()) !== undefined);
            const overlay = (await overlayOf()) ?? fail('no overlay');
            assertEq(overlay.topmost, true, 'above every other window');
            assertEq(overlay.toolWindow, true, 'no taskbar button');
            assertEq(overlay.noActivate, true, 'a click does not activate it');
            assertEq(overlay.affinity, EXCLUDED, 'hidden from screen captures');
            const other = (await windowsOf(blockerPid)).windows[0] ?? fail('the other window is gone');
            if (!(overlay.inFront < other.inFront))
                fail(
                    `the overlay should be in front of the other window (${overlay.inFront} windows in front of it, ${other.inFront} in front of the other)`,
                );
            assertEq((await windowsOf(blockerPid)).foreground, true, 'the other program still has the focus');
            assertEq((await windowsOf(cue.pid)).foreground, false, 'Cue never took it');

            // A real click on the overlay (the Auto switch) does its job and takes no focus.
            await cue.waitFor('the overlay to show its bar', 30, async () => /^Auto$/m.test(await windowText(cue.pid)));
            await click(cue.pid, 'Auto');
            await cue.waitFor(
                'Auto to be off',
                20,
                () =>
                    (JSON.parse(readFileSync(join(cue.support, 'settings.json'), 'utf8')) as { autoAnswer?: boolean }).autoAnswer === false,
            );
            assertEq((await windowsOf(blockerPid)).foreground, true, 'a click on the overlay does not take the focus');

            // What a screenshot or a screen share would show of the overlay's place: the other window, not the overlay.
            const hidden = cue.path('hidden.png');
            await captureScreen(overlay, hidden);
            const seen = cue.save('hidden.txt', await ocr(hidden));
            assertContains(seen, /Blocker window/, 'the capture shows what is behind the overlay');
            assertNotContains(seen, /Ask anything/, 'and not the overlay');

            // Typing into Ask: the one time it takes the keyboard.
            await click(cue.pid, 'Ask anything');
            await cue.waitFor('the overlay to take the keyboard', 20, async () => (await windowsOf(cue.pid)).foreground);
            // Digits: the same keys on every keyboard layout (the VM's is Ukrainian).
            await typeText('4242');
            await pressKeys('enter');
            await cue.waitLog(/❓ \*\*Question:\*\* 4242/, 30);
            await cue.waitFor('the focus to go back', 20, async () => (await windowsOf(blockerPid)).foreground);
            assertEq((await windowsOf(cue.pid)).foreground, false, 'and Cue gave it back');
            assertTextContains(await windowText(cue.pid), /^4242$/, 'the question shows in the list');
        } finally {
            blocker.kill();
        }
    },
);
