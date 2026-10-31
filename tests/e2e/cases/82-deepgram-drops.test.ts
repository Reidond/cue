import { assertEq, DEEPGRAM, dialogue, e2eCase, fail, fixture, skip } from '../harness/index.ts';

e2eCase(
    'When Deepgram drops a live stream partway, the session log and the status say speech recognition is ' +
        'unavailable; the utterance goes again over a new stream, which brings it back, and the line is still transcribed.',
    async (cue) => {
        if (DEEPGRAM !== 'fake') skip('needs the stand-in to drop a stream on purpose');

        await cue.defaults('speechProvider', 'deepgram');
        await cue.defaults('autoAnswer', false);
        await cue.apiKey('deepgram');
        // The participant's first utterance loses its connection at its first audio.
        const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
        await cue.launch({ CUE_REHEARSE_PARTICIPANT: call.wav('call'), FAKE_DEEPGRAM_DROP: '1' });
        await cue.waitLog(/⚠︎ Speech recognition unavailable: Deepgram stopped answering/, 60);
        await cue.waitLog(/🗣 Speech recognition ready again: Deepgram/, 30);
        await cue.waitLog(/\*\*\[Participant\]\*\* Utterance [0-9]+\./, 30);

        const streams = cue.serviceRequests('deepgram-live');
        assertEq(streams.filter((stream) => stream.dropped).length, 1, 'one stream dropped');
        const again =
            streams.find((stream) => !stream.dropped && stream.seconds > 0) ?? fail('the utterance should go again over a new stream');
        assertEq(again.closed, true, 'and that one ends as usual, with CloseStream');
    },
);
