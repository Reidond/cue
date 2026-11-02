import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { accountProject, assertEq, e2eCase, needInteractiveDesktop, pressKeys, windowsOf } from '../harness/index.ts';

e2eCase(
    'Cue for Windows: the system-wide shortcuts (Win+Alt+…) hide and show the overlay, switch Auto answers, and make the text bigger and smaller, ' +
        'wherever the focus is.',
    async (cue) => {
        await needInteractiveDesktop();
        await accountProject(cue, 'Bees');
        await cue.launch({ CUE_PROJECT: 'Bees', CUE_SURFACES: '1' });
        cue.control('start Bees');
        const overlay = async () => (await windowsOf(cue.pid)).windows.find((window) => window.title === 'Cue overlay');
        await cue.waitFor('the overlay', 30, async () => (await overlay()) !== undefined);
        const settings = () =>
            JSON.parse(readFileSync(join(cue.support, 'settings.json'), 'utf8')) as { autoAnswer?: boolean; textSize?: number };
        // No shortcut may be taken by another program.
        assertEq(cue.logCount(/Couldn't register the shortcut/), 0, 'every shortcut registered');

        await pressKeys('win', 'alt', 'h');
        await cue.waitFor('the overlay to hide', 20, async () => (await overlay()) === undefined);
        await pressKeys('win', 'alt', 'h');
        await cue.waitFor('the overlay to show again', 20, async () => (await overlay()) !== undefined);

        await pressKeys('win', 'alt', 'a');
        await cue.waitFor('Auto to be off', 20, () => settings().autoAnswer === false);
        await pressKeys('win', 'alt', 'a');
        await cue.waitFor('Auto to be on', 20, () => settings().autoAnswer === true);

        await pressKeys('win', 'alt', 'plus');
        await cue.waitFor('the text to be bigger', 20, () => settings().textSize === 16);
        await pressKeys('win', 'alt', 'minus');
        await pressKeys('win', 'alt', 'minus');
        await cue.waitFor('the text to be smaller', 20, () => settings().textSize === 14);
        assertEq((await windowsOf(cue.pid)).foreground, false, 'none of it took the focus');
    },
);
