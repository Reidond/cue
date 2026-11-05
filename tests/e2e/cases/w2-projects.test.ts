import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
    assertContains,
    assertDeepEq,
    assertEq,
    assertNotContains,
    assertTextContains,
    e2eCase,
    expand,
    fail,
    fixture,
    isDirectory,
    isFile,
    print,
    sleep,
    windowText,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: a project made in the app reaches the account with its files and settings, shows in the pane and on its page, and comes back on a PC with nothing of it.',
    async (cue) => {
        await cue.launch();
        // What the window shows, as UI Automation reads it.
        const shows = async (pattern: RegExp): Promise<boolean> => pattern.test(await windowText(cue.pid));
        const waitShows = (what: string, pattern: RegExp, seconds = 30) =>
            cue
                .waitFor(what, seconds, () => shows(pattern))
                .catch(async (error: unknown) => {
                    print('--- the window shows', await windowText(cue.pid));
                    throw error;
                });
        assertNotContains(cue.sessionLog(), /Imported \d/, 'a new user has no projects or notes to import');
        const account = await (await cue.backend()).accountOf(cue.email);
        assertEq((await account.projects()).length, 0, 'the account starts with no projects');
        await waitShows('Home to offer the first project', /^Create Your First Project$/m);

        // New Project: the account's project and its folder in the library, with a Notes folder for the notes.
        cue.control('new Bee talk');
        const project = cue.projectPath('Bee talk');
        await cue.waitFor('the project folder', 15, () => isFile(join(project, 'project.json')));
        assertContains(join(project, 'project.json'), /"name": "Bee talk"/);
        assertContains(join(project, 'project.json'), /"serverID": "/);
        if (!isDirectory(join(project, 'Notes'))) fail('a project has a Notes folder here');
        const remote = await account.project('Bee talk');
        assertEq(remote.materialCount, 0);
        // The pane lists it, and the project's page is open: its name in both, its materials (none yet) and Advanced.
        await waitShows('the project page', /^Drop slides, documents and notes here$/m);
        const page = await windowText(cue.pid);
        assertEq(page.split('\n').filter((line) => line === 'Bee talk').length >= 2, true, 'the project is in the pane and on its page');
        for (const text of ['Projects', 'New Project', 'Overview', 'Prepared Answers', 'Notes', 'Materials', 'Add Files…', 'Advanced']) {
            assertTextContains(page, new RegExp(`^${text}$`, 'm'), `${text} is on the page`);
        }

        // The file goes to the account, which reads it.
        cue.control(`add ${fixture('materials', 'talk.md')}`);
        await cue.waitLog(/📎 Added talk\.md to Bee talk: 133 words · 3 prepared answers/, 30);
        assertDeepEq(
            (await account.materials(remote)).map((material) => material.name),
            ['talk.md'],
            'the file is in the account',
        );
        if (isDirectory(join(project, 'Materials'))) fail('nothing is copied into the project folder');
        await waitShows('the file on the page', /^133 words · 3 prepared answers$/m);
        // Cue reads it and prepares the rest (the stand-in's brief has nothing in it).
        await cue.waitLog(/✨ Prepared “Bee talk” from its materials: 0 answers, 0 names and terms/, 60);
        await waitShows('what the account read', /^~\d+ tokens · 3 prepared answers$/m);
        assertTextContains(await windowText(cue.pid), /^Remove talk\.md$/m);
        assertTextContains(await windowText(cue.pid), /^1 file$/m);

        // The prepared answers the account found.
        cue.control('page Bee talk/answers');
        await waitShows('the prepared answers', /^How many hives did you study\?$/m);
        const answers = await windowText(cue.pid);
        assertTextContains(answers, /^We studied 48 hives on 6 rooftops in Kyiv over two seasons\.$/m);
        assertTextContains(answers, /^What were the winter losses\?$/m);
        assertTextContains(answers, /^talk\.md$/m);

        // The settings: saved here at once, and to the account after a moment.
        cue.control('set Bee talk | occasion | A talk at the city council');
        cue.control('set Bee talk | names | Varroa, Kyiv; linden');
        await cue.waitLog(/☁️ Saved “Bee talk” to your account/, 20);
        let saved = remote;
        await cue.waitFor('the settings to reach the account', 20, async () => {
            saved = await account.project('Bee talk');
            return saved.occasion !== '' && saved.terms.length > 0;
        });
        assertEq(saved.occasion, 'A talk at the city council', 'the occasion reached the account');
        assertDeepEq(saved.terms, ['Varroa', 'Kyiv', 'linden']);
        assertContains(join(project, 'project.json'), /"occasion": "A talk at the city council"/);

        // The overview shows them, in the fields under Advanced.
        cue.control('page Bee talk');
        await waitShows('the overview', /^1 file$/m);
        await expand(cue.pid, 'Advanced');
        await waitShows('the fields under Advanced', /^Occasion$/m);
        const overview = await windowText(cue.pid);
        assertTextContains(overview, /^A talk at the city council$/m);
        assertTextContains(overview, /^Varroa, Kyiv; linden$/m);

        // A PC with nothing of the project: its folder is gone, the next launch gets it back from the account.
        await cue.stop();
        await rm(project, { recursive: true, maxRetries: 20, retryDelay: 250 });
        await sleep(1); // session logs are named by the second
        await cue.launch();
        const json = join(project, 'project.json');
        await cue.waitFor('the project back from the account', 20, () => isFile(json));
        assertContains(json, /"occasion": "A talk at the city council"/);
        assertContains(json, /"namesAndTerms": "Varroa, Kyiv; linden"/);
        assertEq((await account.projects()).length, 1, 'and it is still the one project');
        cue.control('page Bee talk');
        await waitShows('the project and its file', /^133 words · 3 prepared answers$/m);
    },
);
