import {
    assertBetween,
    assertEq,
    e2eCase,
    fail,
    FAKE_KEYS,
    fixture,
    makeNotes,
    RECORDED_SCRIPT,
    recordCall,
    waitForNote,
} from '../harness/index.ts';

e2eCase(
    'The notes of a call are recorded as usage: the audio Deepgram read for each side, and the tokens Claude used to suggest names and ' +
        'write the summary, priced; the owner’s keys do the work, and nothing of the user’s token goes upstream.',
    async (cue) => {
        cue.standIns({ FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT, FAKE_CLAUDE_SUMMARY: fixture('summaries', 'speaker-names.md') });
        const backend = await cue.backend();
        const recorded = await recordCall(cue, backend, 'ann@cue.test', { seconds: 12 });
        const note = await makeNotes(backend, recorded);
        await waitForNote(cue, backend, recorded.token, note.id);

        const rows = await backend.rows(
            "SELECT feature, provider, model, unit, units, cost_micros FROM usage WHERE feature IN ('note_transcript', 'note_names', 'notes_summary') ORDER BY feature, model, unit",
        );
        const of = (feature: string) => rows.filter((row) => row['feature'] === feature);

        // Speech: both sides' audio, in seconds, from the provider's own count.
        const speech = of('note_transcript');
        assertEq(speech.length, 2, JSON.stringify(speech));
        for (const row of speech) {
            assertEq(String(row['provider']), 'deepgram');
            assertEq(String(row['unit']), 'audio_seconds');
            assertBetween(Number(row['units']), 11.9, 12.1, 'the whole side was read');
            assertEq(Number(row['cost_micros']) > 0, true, 'speech is priced');
        }
        // Claude: the names and the summary each used input and output tokens.
        for (const feature of ['note_names', 'notes_summary']) {
            const tokens = of(feature);
            if (tokens.length === 0) fail(`${feature} should have used tokens`, JSON.stringify(rows));
            for (const row of tokens) {
                assertEq(String(row['provider']), 'anthropic');
                assertEq(String(row['model']).startsWith('claude-'), true);
            }
            assertEq(
                tokens.some((row) => row['unit'] === 'input_tokens') && tokens.some((row) => row['unit'] === 'output_tokens'),
                true,
                feature,
            );
        }

        // The account's usage counts the audio.
        const me = (await backend.call('GET', '/v1/me', recorded.token)).body;
        assertBetween(me.usage.audioSeconds, 23.8, 24.2, 'both sides of 12 s are in the month’s audio');
        assertEq(me.usage.usd > 0, true);

        // The providers got the owner's keys, never the user's token.
        const keys = cue.serviceRequests('anthropic-request').map((request) => request.key);
        assertEq(keys.length > 0 && keys.every((key) => key === FAKE_KEYS.anthropic), true, JSON.stringify(keys));
        for (const request of cue.serviceRequests('deepgram-file')) {
            assertEq(request.key, FAKE_KEYS.deepgram);
            assertEq(JSON.stringify(request.headers).includes(recorded.token), false, "the user's token never reaches Deepgram");
        }
        for (const request of cue.serviceRequests('anthropic-request')) {
            assertEq(JSON.stringify(request.headers).includes(recorded.token), false, "the user's token never reaches Anthropic");
        }
    },
);
