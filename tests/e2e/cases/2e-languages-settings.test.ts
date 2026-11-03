import { assertContains, assertDeepEq, assertNotContains, e2eCase, needWindowSnapshots } from '../harness/index.ts';

e2eCase(
    'Settings › General › Languages: the languages Cue is read in are saved to the account and read back from it; the second is offered ' +
        'once there is a first, the answers’ and notes’ layouts once there are two.',
    async (cue) => {
        needWindowSnapshots();
        const settings = cue.path('cue-settings.png');
        await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png'), CUE_SHOW_SETTINGS: '1', CUE_ME_TICK: '1' });
        const backend = await cue.backend();
        const account = await backend.accountOf(cue.email);
        const saved = async () => ((await backend.call('GET', '/v1/me', account.token)).body as { languages: string[] }).languages;

        /** Settings' text once a snapshot shows `pattern`. */
        const shown = async (name: string, pattern: RegExp): Promise<string> => {
            let text = '';
            await cue.waitFor(`Settings to show ${name}`, 30, async () => {
                text = await cue.snapshotText(settings);
                return pattern.test(text);
            });
            return cue.save(`settings-${name.replace(/\s+/g, '-')}.txt`, text);
        };

        // None yet: Cue follows the language it hears, and there is nothing more to choose.
        const none = await shown('no language', /Read Cue in/);
        assertContains(none, /Languages/);
        assertContains(none, /in the language it hears/);
        assertNotContains(none, /Also in/, 'a second language is offered once there is a first');
        assertNotContains(none, /Subtitles|Switch between them/, 'the layouts are for two languages');

        // Two: saved to the account, and the layouts are offered.
        cue.control('languages en uk');
        await cue.waitLog(/🌐 Languages: English, Ukrainian$/, 20);
        assertDeepEq(await saved(), ['en', 'uk'], 'the account has them, in order');
        const two = await shown('two languages', /Switch between them/);
        assertContains(two, /Also in/);
        assertContains(two, /Українська/, 'each language by its own name');
        assertContains(two, /Subtitles/, 'answers as subtitles at first');

        // One: no layouts.
        cue.control('languages uk');
        await cue.waitLog(/🌐 Languages: Ukrainian$/, 20);
        assertDeepEq(await saved(), ['uk']);
        // The second picker says None now (the two languages' Settings had none to say).
        const one = await shown('one language', /\bNone\b/);
        assertContains(one, /Also in/);
        assertNotContains(one, /Subtitles|Switch between them/, 'the layouts are for two languages');

        // Chosen elsewhere (another Mac): Cue reads them again from the account.
        await backend.call('PUT', '/v1/me/languages', account.token, { body: { languages: ['pl', 'en'] } });
        await cue.waitLog(/🌐 Languages: Polish, English$/, 20);
        await shown('the account’s languages', /Polski/);

        // None again.
        cue.control('languages');
        await cue.waitLog(/🌐 Languages: none — Cue follows the language it hears$/, 20);
        assertDeepEq(await saved(), [], 'cleared in the account');
        // A language Cue doesn't know is refused by the account, and the app says so.
        cue.control('languages en xx');
        await cue.waitLog(/⚠︎ Couldn't save your languages: /, 20);
        assertDeepEq(await saved(), [], 'nothing was saved');
    },
);
