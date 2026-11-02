import { join } from 'node:path';
import {
    assertContains,
    assertDeepEq,
    assertEq,
    assertTextContains,
    assertTextNotContains,
    e2eCase,
    exec,
    fail,
    fixture,
    isDirectory,
    isFile,
    print,
    windowText,
} from '../harness/index.ts';

e2eCase(
    "Cue for Windows: the account's projects show on a PC that has none of them, in the order Explorer sorts them; a project renamed or deleted from the pane changes in the account and the library; signing out empties the pane.",
    async (cue) => {
        const backend = await cue.backend();
        await backend.invite(cue.email);
        const account = await backend.accountOf(cue.email);
        const create = async (name: string, body: Record<string, string> = {}): Promise<{ id: string }> =>
            (await backend.call('POST', '/v1/projects', account.token, { body: { name, language: 'en', ...body } })).body as { id: string };
        const doomed = `Old talk ${process.pid}`;
        const bees = await create('Bee talk', { occasion: 'A talk at the city council' });
        await backend.call('POST', `/v1/projects/${bees.id}/materials`, account.token, { file: { path: fixture('materials', 'talk.md') } });
        await create('Talk 10');
        await create('Talk 2');
        await create('Семінар', { language: 'uk' });
        await create(doomed);

        await cue.launch();
        const shows = async (pattern: RegExp): Promise<boolean> => pattern.test(await windowText(cue.pid));
        const waitShows = (what: string, pattern: RegExp, seconds = 30) =>
            cue
                .waitFor(what, seconds, () => shows(pattern))
                .catch(async (error: unknown) => {
                    print('--- the window shows', await windowText(cue.pid));
                    throw error;
                });

        // Each has its folder here, made when it is first seen, with the settings the account holds.
        for (const name of ['Bee talk', 'Talk 10', 'Talk 2', 'Семінар', doomed]) {
            await cue.waitFor(`the folder of ${name}`, 30, () => isFile(join(cue.projectPath(name), 'project.json')));
            if (!isDirectory(join(cue.projectPath(name), 'Notes'))) fail(`${name} has no Notes folder`);
            assertContains(join(cue.projectPath(name), 'project.json'), /"serverID": "/);
        }
        assertContains(join(cue.projectPath('Bee talk'), 'project.json'), /"occasion": "A talk at the city council"/);
        assertContains(join(cue.projectPath('Семінар'), 'project.json'), /"language": "uk"/);

        // The pane: a name for each, numbers as Explorer sorts them (Talk 2 before Talk 10).
        await waitShows('the pane to list the projects', /^Семінар$/m);
        const pane = (await windowText(cue.pid)).split('\n');
        const order = ['Bee talk', 'Talk 2', 'Talk 10', 'Семінар'].map((name) => pane.indexOf(name));
        assertEq(
            order.every((index) => index >= 0) && order.every((index, at) => at === 0 || index > order[at - 1]!),
            true,
            `the pane's order: ${order.join(', ')}`,
        );
        assertTextContains(pane.join('\n'), /^Projects$/m);

        // A project's page: its files and settings as the account has them.
        cue.control('page Bee talk');
        await waitShows('the project and its file', /^133 words · 3 prepared answers$/m);
        const page = await windowText(cue.pid);
        assertTextContains(page, /^A talk at the city council$/m);
        assertTextContains(page, /^English · 1 file$/m);
        cue.control('page Bee talk/answers');
        await waitShows('its prepared answers', /^What were the winter losses\?$/m);

        // Rename (the pane's menu runs the same): the account, the folder and the page follow.
        cue.control('rename-project Bee talk | Bees');
        await cue.waitFor('the account to have the new name', 30, async () =>
            (await account.projects()).some((project) => project.name === 'Bees'),
        );
        assertEq(
            (await account.projects()).some((project) => project.name === 'Bee talk'),
            false,
        );
        await cue.waitFor('the folder to move', 30, () => isFile(join(cue.projectPath('Bees'), 'project.json')));
        assertEq(isDirectory(cue.projectPath('Bee talk')), false, 'the old folder is gone');
        assertContains(join(cue.projectPath('Bees'), 'project.json'), /"name": "Bees"/);
        assertEq((await account.materials(await account.project('Bees'))).length, 1, 'with its file');
        await waitShows('the page to carry the new name', /^Bees$/m);
        const renamed = await windowText(cue.pid);
        assertEq(renamed.split('\n').filter((line) => line === 'Bees').length >= 2, true, 'the new name is in the pane and on the page');
        assertTextNotContains(renamed, /^Bee talk$/m);
        assertTextContains(renamed, /^What were the winter losses\?$/m, 'and the page is still open on its prepared answers');

        // Delete: gone from the account, and the folder is in the Recycle Bin (not deleted for good).
        cue.control(`delete-project ${doomed}`);
        await cue.waitFor('the account to lose it', 30, async () => !(await account.projects()).some((project) => project.name === doomed));
        assertEq(isDirectory(cue.projectPath(doomed)), false, 'the folder left the library');
        const bin = await exec('powershell.exe', [
            '-NoProfile',
            '-Command',
            '(New-Object -ComObject Shell.Application).NameSpace(10).Items() | ForEach-Object { $_.Name }',
        ]);
        assertTextContains(bin.stdout, new RegExp(`^${doomed}$`, 'm'), 'it is in the Recycle Bin');
        await cue.waitFor('the pane to lose it', 30, async () => !(await shows(new RegExp(`^${doomed}$`, 'm'))));
        assertEq((await account.projects()).length, 4);

        // The pane is the signed-in person's: signing out empties it, signing in fills it again.
        cue.control('signout');
        await cue.waitLog(/🔑 Signed out of Cue/, 30);
        await waitShows('the pane to be empty', /^Sign in to Cue$/m);
        assertTextNotContains(await windowText(cue.pid), /^Talk 2$/m);
        assertTextNotContains(await windowText(cue.pid), /^New Project$/m);
        const before = cue.logCount(/🔑 Signed in to Cue as /);
        cue.control('signin');
        await cue.waitFor('the second sign-in', 60, () => cue.logCount(/🔑 Signed in to Cue as /) === before + 1);
        await waitShows('the pane to list the projects again', /^Talk 10$/m);
        assertDeepEq((await account.projects()).map((project) => project.name).sort(), ['Bees', 'Talk 10', 'Talk 2', 'Семінар'].sort());
    },
);
