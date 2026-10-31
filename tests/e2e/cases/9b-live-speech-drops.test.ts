import { readFileSync } from 'node:fs';
import { assertEq, bursts, e2eCase, fail, LiveClient, pcmOf, startCall } from '../harness/index.ts';

e2eCase('When Deepgram drops a live stream partway, the call says speech recognition is unavailable, opens it again, and goes on transcribing.', async (cue) => {
    // The first utterance loses its connection as it starts.
    cue.standIns({ FAKE_DEEPGRAM_DROP: '1', FAKE_DEEPGRAM_LIVE: JSON.stringify(['First.', 'The second goes through.']) });
    const backend = await cue.backend();
    const call = await startCall(backend, 'ann@cue.test');
    const live = await LiveClient.connect(backend, call.token, call.callId);
    await live.next('status', (status) => status.part === 'speech' && status.state === 'ready', 30);
    const first = live.lastSeq;
    // Speech, a pause, speech again: the stream breaks during the first, and its replacement hears the rest.
    await live.play('others', pcmOf(readFileSync(await bursts(cue.path('call.wav'), 10, [[1, 4], [7, 9]]))));
    const down = await live.next('status', (status) => status.part === 'speech' && status.state === 'unavailable', 10, first);
    if (!/stopped answering/.test(down.detail)) fail(`the reason should say it stopped answering: "${down.detail}"`);
    await live.next('status', (status) => status.part === 'speech' && status.state === 'ready', 10, down.seq);
    const line = await live.next('transcript.final', () => true, 20);
    if (line.text === '') fail('a line should still be transcribed');
    // Deepgram notes a stream when it ends.
    await backend.call('POST', `/v1/calls/${call.callId}/end`, call.token);
    const streams = cue.serviceRequests('deepgram-live').filter((stream) => stream.side === 'others');
    assertEq(streams.filter((stream) => stream.dropped).length, 1, 'one stream was dropped');
    assertEq(streams.length >= 2, true, 'and another opened in its place');
});
