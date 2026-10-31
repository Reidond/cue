import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertEq, bursts, e2eCase, fail, FAKE_KEYS, LiveClient, pcmOf, startCall } from '../harness/index.ts';

e2eCase("The owner's keys reach Anthropic and Deepgram, and the user's token never does; nobody else can join a call.", async (cue) => {
    cue.standIns({ FAKE_DEEPGRAM_LIVE: JSON.stringify(['Is this on?']) });
    const backend = await cue.backend();
    const call = await startCall(backend, 'ann@cue.test');
    const live = await LiveClient.connect(backend, call.token, call.callId);
    await live.next('status', (status) => status.part === 'judge' && status.state === 'ready', 30);
    await live.next('status', (status) => status.part === 'speech' && status.state === 'ready', 30);
    await live.play('others', pcmOf(readFileSync(await bursts(cue.path('call.wav'), 5, [[1, 2.5]]))));
    const asked = await live.next('question', () => true, 30);
    await live.next('answer.done', (event) => event.questionId === asked.id, 30);

    const anthropic = cue.serviceRequests('anthropic-request');
    if (anthropic.length < 3) fail('requests should have reached Anthropic', JSON.stringify(anthropic));
    for (const request of anthropic) {
        assertEq(request.key, FAKE_KEYS.anthropic, "Anthropic gets the owner's key");
        assertEq(request.headers['authorization'], undefined, 'and no Authorization header at all');
    }
    // Deepgram notes a stream when it ends.
    await backend.call('POST', `/v1/calls/${call.callId}/end`, call.token);
    const deepgram = cue.serviceRequests('deepgram-live');
    assertEq(deepgram.length >= 2, true, 'a stream per side reached Deepgram');
    for (const stream of deepgram) assertEq(stream.key, FAKE_KEYS.deepgram, "Deepgram gets the owner's key");

    // Nothing a stand-in was sent holds the user's token, or the refresh token's kind of secret.
    const folder = join(cue.dir, 'claude');
    for (const name of readdirSync(folder)) {
        if (readFileSync(join(folder, name), 'utf8').includes(call.token)) fail(`the user's token reached a stand-in (${name})`);
    }

    // Nobody else joins: no token, a token of another person, a call that is not theirs.
    await backend.invite('bob@cue.test');
    const other = await startCall(backend, 'carol@cue.test');
    const bob = (await backend.tokensFor('bob@cue.test')).access_token;
    await LiveClient.connect(backend, 'not-a-token', call.callId).then(
        () => fail('a bad token should be refused'),
        () => undefined,
    );
    await LiveClient.connect(backend, bob, other.callId).then(
        () => fail("another person's call should not open"),
        () => undefined,
    );
    assertEq((await backend.call('POST', `/v1/calls/${other.callId}/end`, bob)).status, 404, 'another person cannot end it');
    assertEq(
        (await backend.call('POST', `/v1/calls/${other.callId}/questions`, bob, { body: { text: 'Hi?' } })).status,
        404,
        'nor ask in it',
    );
    assertEq(
        (await backend.call('POST', '/v1/calls', bob, { body: { projectId: 'someone-elses' } })).status,
        404,
        'nor start one on a project that is not theirs',
    );
    assertEq(
        (await backend.call('POST', '/v1/calls', 'not-a-token', { body: { projectId: 'x' } })).status,
        401,
        'a call needs a signed-in person',
    );
});
