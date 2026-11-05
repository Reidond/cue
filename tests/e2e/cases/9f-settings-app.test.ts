import { readFileSync } from 'node:fs';
import type { AccountSettings } from '../../../packages/contract/src/index.ts';
import { assertContains, assertDeepEq, assertEq, assertTextContains, e2eCase, fixture, needWindowSnapshots } from '../harness/index.ts';

e2eCase(
    "The person's settings are kept in their account: the first sign-in sends this Mac's, Settings shows the account's and follows a change made " +
        'on another device, a change made here is saved there, and a call under way follows them.',
    async (cue) => {
        needWindowSnapshots();
        // This Mac's settings, from before the account kept them.
        await cue.defaults('speakerName', 'Mac Name');
        await cue.defaults('autoAnswer', false);
        await cue.defaults('micQuestions', true);
        await cue.defaults('summarizeRecordings', false);
        await cue.defaults('keepAudio', false);
        await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png'), CUE_SHOW_SETTINGS: '1', CUE_ME_TICK: '1' });
        const backend = await cue.backend();
        const account = await backend.accountOf(cue.email);
        const saved = async () => (await backend.call('GET', '/v1/me', account.token)).body.settings as AccountSettings;
        const settings = cue.path('cue-settings.png');
        /** Settings' text once a snapshot shows `pattern`. */
        const shown = async (name: string, pattern: RegExp): Promise<string> => {
            let text = '';
            await cue.waitFor(`Settings to show ${name}`, 30, async () => {
                text = await cue.snapshotText(settings);
                return pattern.test(text);
            });
            return cue.save(`settings-${name.replace(/\s+/g, '-')}.txt`, text);
        };

        // The account had none: this Mac's went there at sign-in, and are the ones in effect.
        assertEq(cue.logCount(/📦 Imported your settings from this Mac$/), 1);
        await cue.waitLog(/⚙️ Settings: name “Mac Name”, Auto off, questions from the room on, summaries off, audio not kept$/, 20);
        assertDeepEq(await saved(), {
            speakerName: 'Mac Name',
            autoAnswer: false,
            micQuestions: true,
            summarize: false,
            keepAudio: false,
        });
        const general = await shown('the name', /Mac Name/);
        // The footer under the name, however it wraps.
        assertTextContains(
            readFileSync(general, 'utf8').replace(/\s+/g, ' '),
            /are kept in your Cue account: the same on every Mac and PC/,
        );

        // Changed on another device: this Mac follows.
        await backend.call('PATCH', '/v1/me/settings', account.token, {
            body: { speakerName: 'Ann Other', autoAnswer: true, keepAudio: true },
        });
        await cue.waitLog(/⚙️ Settings: name “Ann Other”, Auto on, questions from the room on, summaries off, audio kept$/, 20);
        await shown('the name from the account', /Ann Other/);

        // A call is made without them, and the server answers by the account's: Claude's prompt names the speaker it has.
        cue.control('new Bees');
        cue.control(`add ${fixture('materials', 'talk.md')}`);
        await cue.waitLog(/Added talk\.md to Bees/, 30);
        const prompts = (name: string) =>
            cue.claudeRequests('answer-system').filter((system) => system.startsWith(`You are a live prompter for ${name}.`)).length;
        cue.control('start Bees');
        await cue.waitFor("Claude's prompt to name the account's speaker", 30, () => prompts('Ann Other') > 0);

        // Changed here: saved to the account, and the call under way follows.
        cue.control('setting summarize | on');
        await cue.waitLog(/⚙️ Settings: name “Ann Other”, Auto on, questions from the room on, summaries on, audio kept$/, 20);
        assertEq((await saved()).summarize ?? undefined, true);
        cue.control('setting speakerName | Mac Again');
        await cue.waitLog(/⚙️ Settings: name “Mac Again”, /, 20);
        assertEq((await saved()).speakerName ?? undefined, 'Mac Again');
        await cue.waitFor('the call under way to name the new speaker', 30, () => prompts('Mac Again') > 0);
        assertContains(cue.sessionLog(), /☁️ Saved your settings to your account/);
        cue.control('stop');

        // The next launch sends nothing: the account has them, and they are the ones in effect.
        await cue.stop();
        await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png'), CUE_SHOW_SETTINGS: '1', CUE_ME_TICK: '1' });
        await cue.waitLog(/⚙️ Settings: name “Mac Again”, Auto on, questions from the room on, summaries on, audio kept$/, 20);
        assertEq(cue.logCount(/📦 Imported your settings/), 0, 'the settings are imported once');
    },
);
