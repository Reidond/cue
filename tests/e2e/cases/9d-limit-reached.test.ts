import { assertEq, e2eCase, fixture, startCall } from '../harness/index.ts';

const OWNER = 'owner@cue.test';

e2eCase(
    'Over the monthly limit nothing that costs money starts: a call, a question, a material answer 402 limit_reached with a sentence the app can show as ' +
        'it is; free routes still work, /v1/me says so, and raising the limit in the admin lets everything start again.',
    async (cue) => {
        const backend = await cue.backend({ adminEmails: [OWNER] });
        const call = await startCall(backend, 'ann@cue.test', { materials: [fixture('materials', 'talk.md')] });
        const as = (method: string, path: string, options: { body?: unknown; file?: { path: string } } = {}) =>
            backend.call(method, path, call.token, options);

        // The default limit is 20 USD; ann has spent all of it.
        await backend.seedUsage('ann@cue.test', [{ feature: 'answer', usd: 20 }]);

        const started = await as('POST', '/v1/calls', { body: { projectId: call.projectId } });
        assertEq(started.status, 402);
        assertEq(started.body.error.code, 'limit_reached');
        assertEq(started.body.error.retryable, false);
        assertEq(started.body.error.message.includes('$20.00 of your $20.00'), true, started.body.error.message);
        assertEq(started.body.error.message.endsWith('(UTC).'), true, 'a sentence that says when it starts over');

        const asked = await as('POST', `/v1/calls/${call.callId}/questions`, { body: { text: 'Why rooftops?' } });
        assertEq(asked.status, 402, 'the Ask field');
        assertEq(asked.body.error.code, 'limit_reached');

        const material = await as('POST', `/v1/projects/${call.projectId}/materials`, { file: { path: fixture('materials', 'talk.md') } });
        assertEq(material.status, 402, 'a material');
        assertEq(material.body.error.code, 'limit_reached');

        // A call made only to hang a recording's notes on has no live path and costs nothing: the limit does not stop it.
        const notesOnly = await as('POST', '/v1/calls', { body: { projectId: call.projectId, notesOnly: true } });
        assertEq(notesOnly.status, 201, 'a call for the notes only');
        const [row] = await backend.rows(`SELECT ended_at FROM call WHERE id = '${String(notesOnly.body.callId)}'`);
        assertEq(row?.['ended_at'] !== null, true, 'it starts over');

        // What costs nothing still works, and /v1/me tells the story.
        assertEq((await as('GET', '/v1/projects')).status, 200);
        const me = (await as('GET', '/v1/me')).body;
        assertEq(me.usage.limitReached, true);
        assertEq(me.usage.usd, 20);
        assertEq(me.limits.monthlyUsd, 20);

        // The owner gives ann more: everything starts again.
        await backend.setLimit(OWNER, 'ann@cue.test', 50);
        assertEq((await as('GET', '/v1/me')).body.usage.limitReached, false);
        assertEq((await as('POST', '/v1/calls', { body: { projectId: call.projectId } })).status, 201, 'a call');
        assertEq((await as('POST', `/v1/calls/${call.callId}/questions`, { body: { text: 'Why rooftops?' } })).status, 200, 'a question');
        assertEq((await as('POST', `/v1/projects/${call.projectId}/materials`, { file: { path: fixture('materials', 'talk.md') } })).status, 200, 'a material');

        // A limit of nothing stops everything at once; the default comes back with `null`.
        await backend.setLimit(OWNER, 'ann@cue.test', 0);
        assertEq((await as('POST', '/v1/calls', { body: { projectId: call.projectId } })).status, 402);
        await backend.setLimit(OWNER, 'ann@cue.test', null);
        assertEq((await as('POST', '/v1/calls', { body: { projectId: call.projectId } })).status, 402, 'back on the default, which is spent');
    },
);
