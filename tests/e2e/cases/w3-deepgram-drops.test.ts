import { accountProject, assertEq, bursts, DEEPGRAM, e2eCase, fail, skip } from '../harness/index.ts';

e2eCase(
    'Cue for Windows: when Deepgram drops a live stream partway, the session log says speech recognition is unavailable; the backend opens the stream ' +
        'again, which brings it back, and the call goes on being transcribed.',
    async (cue) => {
        if (DEEPGRAM !== 'fake') skip('needs the stand-in to drop a stream on purpose');
        await accountProject(cue, 'Bees');
        await cue.defaults('autoAnswer', false);
        const call = await bursts(cue.path('call.wav'), 10, [[1, 4]]);
        // The participant's first utterance loses its connection as it starts.
        await cue.launch({ CUE_PROJECT: 'Bees', CUE_REHEARSE_PARTICIPANT: call, FAKE_DEEPGRAM_DROP: '1' });
        await cue.waitLog(/⚠︎ Speech recognition unavailable: Speech recognition stopped answering/, 60);
        await cue.waitLog(/🗣 Speech recognition ready again: Cue plan/, 30);
        // The utterance goes on over the new stream, and is still transcribed (the stand-in numbers the utterances it hears).
        await cue.waitLog(/\*\*\[Participant\]\*\* Utterance [0-9]+\./, 30);

        cue.control('stop');
        await cue.waitFor(
            'the streams to end',
            20,
            () => cue.serviceRequests('deepgram-live').filter((stream) => stream.side === 'others').length >= 2,
        );
        const streams = cue.serviceRequests('deepgram-live').filter((stream) => stream.side === 'others');
        assertEq(streams.filter((stream) => stream.dropped).length, 1, 'one stream dropped');
        const again = streams.find((stream) => !stream.dropped && stream.seconds > 0) ?? fail('the call should go on over a new stream');
        assertEq(again.closed, true, 'and that one ends as usual, with CloseStream');
    },
);
