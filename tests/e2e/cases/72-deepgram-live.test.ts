import {
    assertBetween, assertContains, assertEq, audioLength, DEEPGRAM, e2eCase, fail, FAKE_KEYS, speech,
} from '../harness/index.ts';

e2eCase("With Deepgram, what's said on the call is streamed to it while it's said — the stream opened as speech starts, "
    + "the audio sent every 0.2 s — and comes back as the live transcript, in the project's language and with its names "
    + 'and terms, and its questions get answers.', async (cue) => {
    await cue.project('Bees', { language: 'en', namesAndTerms: 'Apis mellifera, varroa mite; Olena Mulesa' });
    await cue.defaults('speechProvider', 'deepgram');
    await cue.defaults('autoAnswer', true);
    await cue.apiKey('deepgram');
    const question = cue.path('question.wav');
    await speech(question, 'Daniel', 'Thank you for the talk. How many hives did you study?');
    await cue.launch({
        CUE_PROJECT: 'Bees', CUE_REHEARSE_PARTICIPANT: question,
        FAKE_DEEPGRAM_LIVE: JSON.stringify(['Thank you for the talk. How many hives did you study?']),
    });
    await cue.waitLog(/🗣 Speech recognition: Deepgram/, 10);
    await cue.waitLog(/\*\*\[Participant\]\*\* .*hives/, 60);
    await cue.waitLog(/Question:.*hives/, 30);
    assertContains(cue.sessionLog(), /\*\*\[Participant\]\*\* .*how many hives did you study\?/);

    if (DEEPGRAM === 'fake') {
        const streams = cue.serviceRequests('deepgram-live');
        const stream = streams.find((request) => request.seconds > 0) ?? fail('the question should be streamed to Deepgram');
        assertEq(stream.key, FAKE_KEYS.deepgram);
        assertEq(stream.query['model'], 'nova-3');
        assertEq(stream.query['language'], 'en');
        assertEq(stream.query['encoding'], 'linear16');
        assertEq(stream.query['sample_rate'], '16000');
        assertEq(stream.query['interim_results'], 'true');
        assertEq(stream.keyterms.join(' | '), 'Apis mellifera | varroa mite | Olena Mulesa', "the project's names and terms");
        assertEq(stream.closed, true, 'Cue closes the stream once the participant pauses');
        const spoken = await audioLength(question);
        // Every 0.2 s while it's said: the first words show about a second after they're spoken.
        if ((stream.messages ?? 0) < stream.seconds / 0.35) {
            fail(`the audio should go out every 0.2 s while it's said: ${stream.messages} message(s) for ${stream.seconds.toFixed(1)} s`);
        }
        // Opened when the speech started, ready by the time its first audio comes.
        assertBetween(stream.waited, 0.1, 1, 'the stream should open as speech starts, before its first audio');
        assertBetween(stream.seconds, (spoken ?? 0) * 0.6, (spoken ?? 0) + 1.5, `about the ${spoken} s spoken, and no silence`);
    }
});
