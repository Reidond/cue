import { assertContains, assertEq, audioLength, DEEPGRAM, e2eCase, fail, FAKE_KEYS, skip, sleep, speech } from '../harness/index.ts';

e2eCase(
    "What's said on the call is streamed by the backend to Deepgram while it's said, in the project's language and with " +
        "its names and terms, one stream a side with the voices told apart on the call's; it comes back as the live " +
        'transcript, and its questions get answers.',
    async (cue) => {
        if (DEEPGRAM !== 'fake') skip('looks at what the backend sends the stand-in');

        await cue.project('Bees', { language: 'en', namesAndTerms: 'Apis mellifera, varroa mite; Olena Mulesa' });
        await cue.defaults('autoAnswer', true);
        const question = cue.path('question.wav');
        await speech(question, 'Daniel', 'Thank you for the talk. How many hives did you study?');
        await cue.launch({
            CUE_PROJECT: 'Bees',
            CUE_REHEARSE_PARTICIPANT: question,
            FAKE_DEEPGRAM_LIVE: JSON.stringify(['Thank you for the talk. How many hives did you study?']),
        });
        await cue.waitLog(/🗣 Speech recognition: Cue plan/, 10);
        await cue.waitLog(/\*\*\[Participant\]\*\* .*hives/, 60);
        await cue.waitLog(/Question:.*hives/, 30);
        assertContains(cue.sessionLog(), /\*\*\[Participant\]\*\* .*how many hives did you study\?/);

        // The microphone said nothing: its stream is kept open for the whole call (Deepgram closes one that is quiet for 10 s) by KeepAlive.
        await sleep(12);
        if (cue.logCount(/Speech recognition unavailable/) > 0) fail('a quiet microphone should not lose its stream');
        cue.control('stop');
        await cue.waitFor('both streams to end', 20, () => cue.serviceRequests('deepgram-live').length >= 2);

        const streams = cue.serviceRequests('deepgram-live');
        const call = streams.find((stream) => stream.side === 'others') ?? fail('the call side should be streamed to Deepgram');
        const mic = streams.find((stream) => stream.side === 'me') ?? fail('and the microphone has a stream of its own');
        for (const stream of streams) {
            assertEq(stream.key, FAKE_KEYS.deepgram, "the owner's key, not anything of the person's");
            assertEq(stream.query['model'], 'nova-3');
            assertEq(stream.query['language'], 'en');
            assertEq(stream.query['encoding'], 'linear16');
            assertEq(stream.query['sample_rate'], '16000');
            assertEq(stream.query['interim_results'], 'true');
            assertEq(stream.query['vad_events'], 'true');
            assertEq(stream.query['endpointing'], '700');
            assertEq(stream.keyterms.join(' | '), 'Apis mellifera | varroa mite | Olena Mulesa', "the project's names and terms");
            assertEq(stream.closed, true, 'the backend closes the stream when the call ends');
        }
        assertEq(call.query['diarize'], 'true', "the call's voices are told apart");
        assertEq(mic.query['diarize'], undefined, 'the microphone is one voice');
        assertEq(mic.seconds, 0, 'nothing was said into it, and nothing was sent');
        assertEq(mic.keepAlives >= 1, true, 'so it was kept open with KeepAlive');
        const spoken = (await audioLength(question)) ?? fail("can't measure the question");
        // Everything of the call side goes up as it is captured, the quiet after it too (the server's clock is the samples it gets): at least
        // what was said, and no more than the call has lasted.
        if (call.seconds < spoken * 0.8 || call.seconds > spoken + 60) {
            fail(`at least the ${spoken} s spoken should be sent, and not more than the call lasted, not ${call.seconds.toFixed(1)} s`);
        }
        assertEq(call.messages > call.seconds, true, 'in small pieces, many a second');
    },
);
