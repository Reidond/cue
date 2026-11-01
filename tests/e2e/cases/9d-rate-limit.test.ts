import { assertEq, e2eCase, startCall } from '../harness/index.ts';

e2eCase(
    'A person who sends too many requests too quickly is answered 429 rate_limited (retryable) for them alone; what starts paid work has a stricter ' +
        'rate of its own; the window passes and requests are answered again.',
    async (cue) => {
        const backend = await cue.backend({ env: { RATE_LIMIT_REQUESTS: '6', RATE_LIMIT_PERIOD: '10', RATE_LIMIT_COSTLY_REQUESTS: '2' } });
        await backend.invite('bob@cue.test');
        const bob = (await backend.tokensFor('bob@cue.test')).access_token;
        const projectId = (await backend.call('POST', '/v1/projects', bob, { body: { name: 'Bee talk', language: 'en' } })).body
            .id as string;
        const call = await startCall(backend, 'ann@cue.test');

        // Ann has used 3 requests of 6 (the project, the call, …): a burst of /v1/me goes over.
        const statuses: number[] = [];
        let last: { status: number; body: any } | undefined;
        for (let index = 0; index < 12; index++) {
            last = await backend.call('GET', '/v1/me', call.token);
            statuses.push(last.status);
        }
        assertEq(statuses[0], 200);
        assertEq(statuses.includes(429), true, `a burst is limited: ${statuses.join(' ')}`);
        assertEq(last?.body.error.code, 'rate_limited');
        assertEq(last?.body.error.retryable, true);

        // The limit is per person.
        assertEq((await backend.call('GET', '/v1/me', bob)).status, 200, 'bob is not limited by ann');

        // The window passes.
        await cue.waitFor('ann to be answered again', 30, async () => (await backend.call('GET', '/v1/me', call.token)).status === 200);

        // Calls cost money: two a minute here, the third is refused even though the general rate has room.
        const results: number[] = [];
        for (let index = 0; index < 3; index++) {
            const started = await backend.call('POST', '/v1/calls', bob, { body: { projectId } });
            results.push(started.status);
            if (started.status === 429) assertEq(started.body.error.code, 'rate_limited');
            await new Promise((resolve) => setTimeout(resolve, 2500));
        }
        assertEq(results.join(' '), '201 201 429', 'the third call in a minute');
    },
);
