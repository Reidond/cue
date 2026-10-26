import {
    ANTHROPIC, assertBetween, assertContains, assertEq, audioLength, DEEPGRAM, dialogue, e2eCase, fail, fixture,
} from '../harness/index.ts';

e2eCase("With Deepgram and the Anthropic API, a recorded call's second pass goes through Deepgram and its summary "
    + 'through the API.', async (cue) => {
    await cue.defaults('claudeProvider', 'anthropicAPI');
    await cue.defaults('speechProvider', 'deepgram');
    await cue.defaults('speakerName', 'Andrii Test');
    await cue.defaults('autoAnswer', false);
    await cue.apiKey('anthropic');
    await cue.apiKey('deepgram');
    await cue.project('Report', { language: 'en', namesAndTerms: 'beekeeping report' });
    const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
    await cue.launch({
        CUE_PROJECT: 'Report', CUE_REHEARSE_RECORD: '1', CUE_REHEARSE_PARTICIPANT: call.wav('call'), CUE_REHEARSE_ME: call.wav('me'),
    });
    await cue.waitLog(/Transcript saved/, 120);
    await cue.waitLog(/✅ Transcript improved: [0-9]+ segments/, 120);
    await cue.waitLog(/Notes ready/, 180);
    // Both sides were heard live.
    assertContains(cue.sessionLog(), /\*\*\[Participant\]\*\* /);
    assertContains(cue.sessionLog(), /\*\*\[Andrii Test\]\*\* /);

    const notes = cue.readyNotes();
    assertContains(notes, /^\*\*00:00:[0-9]{2} · Participant\*\*/);
    assertContains(notes, /^\*\*00:00:[0-9]{2} · Andrii Test\*\*/);
    assertContains(notes, /^## Summary/);
    if (DEEPGRAM === 'fake') {
        assertContains(notes, /Second pass by Deepgram, part 1\./, "the transcript is Deepgram's second pass");
        const files = cue.serviceRequests('deepgram-file');
        assertEq(files.length, 2, 'each side goes to Deepgram once');
        const length = await audioLength(call.wav('call')) ?? fail("can't measure the call");
        for (const file of files) {
            assertEq(file.query['model'], 'nova-3');
            assertEq(file.query['language'], 'en');
            assertEq(file.query['utterances'], 'true');
            assertEq(file.contentType, 'audio/wav');
            assertEq(file.keyterms.join(' | '), 'beekeeping report');
            assertBetween(file.seconds, length - 1, length + 6, 'the whole side, as long as the call');
        }
    } else {
        assertContains(notes, /bee ?keeping report/);
        assertContains(notes, /by Friday/);
    }
    if (ANTHROPIC === 'fake') {
        assertContains(notes, /^title: "E2E rehearsal notes"/);
        const summary = cue.serviceRequests('anthropic-request').find((request) => request.kind === 'summary')
            ?? fail('the summary should be written through the API');
        assertEq(summary.model, 'claude-sonnet-5-5');
        assertEq(summary.stream, true);
        assertContains(cue.save('summary-input.txt', cue.claudeRequests('summary-input').join('')), /\[Participant\]/);
    }
});
