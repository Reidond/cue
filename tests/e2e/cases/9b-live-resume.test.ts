import { readFileSync } from 'node:fs';
import { assertEq, bursts, DEEPGRAM, e2eCase, fail, fixture, LiveClient, pcmOf, skip, startCall } from '../harness/index.ts';

e2eCase(
    'A client that drops and reconnects to the same call resumes it: it hears what it missed, the conversation goes on, and speech recognition was never restarted.',
    async (cue) => {
        if (DEEPGRAM !== 'fake') skip("scripts Deepgram's replies through the stand-in");
        cue.standIns({
            FAKE_DEEPGRAM_LIVE: JSON.stringify(['And what did you find?']),
            FAKE_CLAUDE_ANSWERS: JSON.stringify({ 'many hives': 'Forty eight hives.', 'where were': 'On six rooftops in Kyiv.' }),
            FAKE_CLAUDE_ANSWER: 'Something else.',
        });
        const backend = await cue.backend();
        const call = await startCall(backend, 'ann@cue.test', { materials: [fixture('materials', 'talk.md')] });
        const first = await LiveClient.connect(backend, call.token, call.callId);
        const ready = await first.next('ready', () => true, 10);
        assertEq(ready.resumed, false, 'a first connection');
        await first.next('status', (status) => status.part === 'speech' && status.state === 'ready', 30);
        await first.next('status', (status) => status.part === 'judge' && status.state === 'ready', 30);

        // A question is asked and answered; then the client is gone, and a second question (asked by another client, over HTTP) is answered meanwhile.
        first.command({ type: 'ask', text: 'How many hives did you study?' });
        const asked = await first.next('question', () => true, 10);
        await first.next('answer.done', (event) => event.questionId === asked.id, 30);
        first.drop();
        const lastSeen = first.lastSeq;
        const meanwhile = await fetch(new URL(`/v1/calls/${call.callId}/questions`, backend.url), {
            method: 'POST',
            headers: { authorization: `Bearer ${call.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'Where were the hives?' }),
        });
        assertEq((await meanwhile.text()).includes('On six rooftops in Kyiv.'), true);

        // It reconnects, asking for what came after the last event it saw.
        const second = await LiveClient.connect(backend, call.token, call.callId, lastSeen);
        const again = await second.next('ready', () => true, 10);
        assertEq(again.resumed, true, 'the server knows it is the same call');
        const missed = await second.next('question', () => true, 10);
        assertEq(missed.text, 'Where were the hives?', 'what happened while it was away is sent again');
        await second.next('answer.done', (event) => event.questionId === missed.id, 10);
        assertEq(second.answerTo(missed.id), 'On six rooftops in Kyiv.');
        assertEq(second.of('question').length, 1, 'and nothing it had seen already');
        assertEq(
            second.of('status').some((status) => status.part === 'speech' && status.state === 'starting'),
            false,
            'speech recognition was not started again',
        );

        // The call goes on: audio over the new connection is heard, and a new question is answered with the conversation so far.
        const speech = pcmOf(readFileSync(await bursts(cue.path('call.wav'), 6, [[1, 3]])));
        await second.play('others', speech);
        const next = await second.next('question', (event) => event.text === 'And what did you find?', 30);
        await second.next('answer.done', (event) => event.questionId === next.id, 30);
        const answers = cue.serviceRequests('anthropic-request').filter((request) => request.kind === 'answer' && request.maxTokens > 0);
        assertEq(answers.length, 3);
        assertEq(answers[2]?.messages, 5, 'the third question is asked with the two before it and their answers');

        // Speech recognition stayed up through the gap: one stream a side, no more.
        await backend.call('POST', `/v1/calls/${call.callId}/end`, call.token);
        const streams = cue.serviceRequests('deepgram-live');
        assertEq(streams.filter((stream) => stream.side === 'others').length, 1, 'one stream for the call side');
        assertEq(streams.filter((stream) => stream.side === 'me').length, 1, 'one for the microphone');

        // A call that is over cannot be joined again; nor can another person join it.
        await LiveClient.connect(backend, call.token, call.callId).then(
            () => fail('a call that has ended should refuse a connection'),
            () => undefined,
        );
    },
);

e2eCase('A call nobody comes back to is ended on its own, and what it heard is kept.', async (cue) => {
    if (DEEPGRAM !== 'fake') skip("scripts Deepgram's replies through the stand-in");
    cue.standIns({ FAKE_DEEPGRAM_LIVE: JSON.stringify(['Is this recorded?']) });
    const backend = await cue.backend({ env: { CACHE_TICK_SECONDS: '1', CALL_GRACE_SECONDS: '3' } });
    const call = await startCall(backend, 'ann@cue.test');
    const live = await LiveClient.connect(backend, call.token, call.callId);
    await live.next('status', (status) => status.part === 'speech' && status.state === 'ready', 30);
    await live.play('others', pcmOf(readFileSync(await bursts(cue.path('call.wav'), 5, [[1, 2.5]]))));
    await live.next('transcript.final', () => true, 20);
    live.drop();
    await cue.waitFor(
        'the abandoned call to be ended',
        30,
        async () => (await backend.rows(`SELECT ended_at FROM call WHERE id = '${call.callId}'`))[0]?.['ended_at'] != null,
    );
    const [row] = await backend.rows(`SELECT transcript FROM call WHERE id = '${call.callId}'`);
    assertEq(String(row?.['transcript']).includes('Is this recorded?'), true, 'its transcript is kept');
});
