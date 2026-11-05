import type { AccountSettings } from '../../../packages/contract/src/index.ts';
import { assertDeepEq, assertEq, e2eCase } from '../harness/index.ts';

const NONE: AccountSettings = { speakerName: null, autoAnswer: null, micQuestions: null, summarize: null, keepAudio: null };

e2eCase(
    "A person's settings are kept in their account: none at first, changed one or a few at a time, malformed changes refused, beside their " +
        'languages, and nobody else sees them.',
    async (cue) => {
        const backend = await cue.backend();
        await backend.invite('ann@cue.test');
        const ann = (await backend.tokensFor('ann@cue.test')).access_token;
        const settingsOf = async (token: string) => {
            const me = await backend.call('GET', '/v1/me', token);
            assertEq(me.status, 200);
            return me.body.settings as AccountSettings;
        };
        const patch = (token: string, body: unknown) => backend.call('PATCH', '/v1/me/settings', token, { body });

        // A new account has none: an app signing in sends its own.
        assertDeepEq(await settingsOf(ann), NONE);

        // One at a time, and a few at once; what isn't named stays as it was.
        const named = await patch(ann, { speakerName: 'Ann Tester' });
        assertEq(named.status, 200);
        assertDeepEq(named.body, { ...NONE, speakerName: 'Ann Tester' });
        const more = await patch(ann, { autoAnswer: false, keepAudio: false });
        assertDeepEq(more.body, { ...NONE, speakerName: 'Ann Tester', autoAnswer: false, keepAudio: false });
        await patch(ann, { micQuestions: true, summarize: true, autoAnswer: true });
        const all = { speakerName: 'Ann Tester', autoAnswer: true, micQuestions: true, summarize: true, keepAudio: false };
        assertDeepEq(await settingsOf(ann), all);
        assertEq((await patch(ann, { speakerName: '' })).body.speakerName, '', 'an empty name is a name: "the speaker", "You"');
        await patch(ann, { speakerName: 'Ann Tester' });

        // Malformed: nothing to change, a wrong type, a null, a name too long.
        for (const body of [{}, { autoAnswer: 'yes' }, { keepAudio: null }, { speakerName: 'A'.repeat(201) }]) {
            const refused = await patch(ann, body);
            assertEq(refused.status, 400, `refused: ${JSON.stringify(body)}`);
            assertEq(refused.body.error.code, 'bad_request');
        }
        assertDeepEq(await settingsOf(ann), all, 'a refused change changes nothing');

        // The languages are kept beside them: changing one leaves the other.
        assertEq((await backend.call('PUT', '/v1/me/languages', ann, { body: { languages: ['en', 'uk'] } })).status, 200);
        assertDeepEq(await settingsOf(ann), all, 'choosing languages keeps the settings');
        await patch(ann, { summarize: false });
        assertDeepEq((await backend.call('GET', '/v1/me', ann)).body.languages, ['en', 'uk'], 'changing a setting keeps the languages');

        // Another person has their own (none yet), and changes only theirs.
        await backend.invite('bob@cue.test');
        const bob = (await backend.tokensFor('bob@cue.test')).access_token;
        assertDeepEq(await settingsOf(bob), NONE);
        await patch(bob, { speakerName: 'Bob' });
        assertEq((await settingsOf(ann)).speakerName ?? undefined, 'Ann Tester');

        // Signed in only.
        const anonymous = await fetch(new URL('/v1/me/settings', backend.url), {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ autoAnswer: false }),
        });
        assertEq(anonymous.status, 401);
    },
);
