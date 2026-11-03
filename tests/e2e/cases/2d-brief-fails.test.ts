import { assertEq, e2eCase, fixture, writeFile } from '../harness/index.ts';

const BRIEF = { occasion: 'A talk on rooftop bees.', namesAndTerms: ['linden'], answers: [] };

e2eCase(
    'A brief Claude could not write says why and keeps the one before; asked for again it is written; one that would go over the month’s ' +
        'allowance is not bought.',
    async (cue) => {
        cue.standIns({ FAKE_CLAUDE_BRIEF: JSON.stringify(BRIEF) });
        const backend = await cue.backend({ env: { BRIEF_SETTLE_SECONDS: '4' } });
        const email = 'ann@cue.test';
        await backend.invite(email);
        const account = await backend.accountOf(email);
        const token = account.token;
        const base = `/v1/projects/${((await backend.call('POST', '/v1/projects', token, { body: { name: 'Bee talk' } })).body as { id: string }).id}`;
        const upload = async (path: string) =>
            assertEq((await backend.call('POST', `${base}/materials`, token, { file: { path } })).status, 201);

        await upload(fixture('materials', 'talk.md'));
        assertEq((await account.briefed('Bee talk')).brief.occasion, BRIEF.occasion, 'the first brief');

        // Claude fails every time (each step tried three times): the brief says why, and the one before stays in use.
        cue.standIns({ FAKE_CLAUDE_BRIEF: JSON.stringify(BRIEF), FAKE_ANTHROPIC_BRIEF_FAILS: '1000' });
        await upload(writeFile(cue.path('files', 'notes.md'), 'A hive gives 20 kg of honey.\n'));
        const failed = await account.briefed('Bee talk', 120);
        assertEq(failed.brief.state, 'failed');
        assertEq(failed.brief.error ?? undefined, 'Claude: The brief failed', 'why, for people');
        assertEq(failed.brief.occasion, BRIEF.occasion, 'the brief before is kept');
        assertEq(failed.terms.join(), 'linden', 'and still in use');

        // Asked for again, once Claude answers.
        cue.standIns({
            FAKE_CLAUDE_BRIEF: JSON.stringify({ ...BRIEF, occasion: 'Rooftop bees, again.' }),
            FAKE_ANTHROPIC_BRIEF_FAILS: '0',
        });
        const again = await backend.call('POST', `${base}/brief`, token);
        assertEq(again.status, 202, JSON.stringify(again.body));
        assertEq((again.body as { state: string }).state, 'working');
        const written = await account.briefed('Bee talk');
        assertEq(written.brief.state, 'ready');
        assertEq(written.brief.occasion, 'Rooftop bees, again.');
        assertEq(written.brief.error ?? undefined, undefined, 'the failure is over');

        // The month's allowance runs out while the files settle: the brief is not bought.
        const asked = cue.claudeRequests('brief-input').length;
        await upload(writeFile(cue.path('files', 'more.md'), 'The hives are on six roofs.\n'));
        await backend.seedUsage(email, [{ feature: 'answer', usd: 20 }]);
        const limited = await account.briefed('Bee talk');
        assertEq(limited.brief.state, 'failed');
        assertEq(limited.brief.error ?? undefined, 'Cue plan limit reached');
        assertEq(cue.claudeRequests('brief-input').length, asked, 'Claude was not asked');
        assertEq((await backend.call('POST', `${base}/brief`, token)).body.error.code, 'limit_reached', 'nor can it be asked for');
    },
);
