import {
    assertDeepEq,
    assertEq,
    e2eCase,
    fixture,
    getNote,
    makeNotes,
    RECORDED_SCRIPT,
    recordCall,
    uploadRecording,
    waitForNote,
} from '../harness/index.ts';

e2eCase(
    "A call's notes follow the account's settings — the speaker's name, the summary, keeping the audio — once the account has them, whatever an " +
        'app from before them sends; until then they go by what it sends, and an app of now sends none.',
    async (cue) => {
        cue.standIns({ FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT, FAKE_CLAUDE_SUMMARY: fixture('summaries', 'speaker-names.md') });
        const backend = await cue.backend({ env: { NOTES_RETRY_SECONDS: '1' } });
        const stepsOf = (note: { steps: { id: string }[] }) => note.steps.map((step) => step.id);

        // The account has no settings yet: the notes go by what the app sends (summary on, audio kept, its name).
        const first = await recordCall(cue, backend, 'ann@cue.test');
        const sent = await waitForNote(cue, backend, first.token, (await makeNotes(backend, first, { speaker: 'Old App Name' })).id);
        assertEq(sent.participants[0], 'Old App Name');
        assertDeepEq(stepsOf(sent), ['transcript', 'speakers', 'names', 'summary']);
        assertDeepEq([...sent.audio].sort(), ['me', 'others'], "the audio is kept, as the app's Keep audio says");

        // The account's own: another name, no summary, the audio not kept. An app from before sends the opposite, and it doesn't count.
        const changed = await backend.call('PATCH', '/v1/me/settings', first.token, {
            body: { speakerName: 'Ann Tester', summarize: false, keepAudio: false },
        });
        assertEq(changed.status, 200);
        const second = await recordCall(cue, backend, 'ann@cue.test');
        const old = await waitForNote(
            cue,
            backend,
            second.token,
            (await makeNotes(backend, second, { speaker: 'Old App Name', summarize: true, keepAudio: true })).id,
        );
        assertEq(old.participants[0], 'Ann Tester', "the account's name, not the app's");
        assertDeepEq(stepsOf(old), ['transcript', 'speakers'], 'no summary: the account has summaries off');
        assertEq(old.summary, '');
        await cue.waitFor(
            'the audio to be deleted once the notes are ready (Keep audio is off in the account)',
            30,
            async () => (await getNote(backend, second.token, old.id)).audio.length === 0,
        );

        // An app of now sends none of them: the account's are used.
        const third = await recordCall(cue, backend, 'ann@cue.test');
        await uploadRecording(backend, third.token, third.callId, 'me', third.me, { take: third.take });
        await uploadRecording(backend, third.token, third.callId, 'others', third.others, { take: third.take });
        const bare = await backend.call('POST', `/v1/calls/${third.callId}/notes`, third.token, {
            body: { take: third.take, endedAt: third.endedAt, sides: ['me', 'others'] },
        });
        assertEq(bare.status, 202, JSON.stringify(bare.body));
        const now = await waitForNote(cue, backend, third.token, bare.body.id);
        assertEq(now.participants[0], 'Ann Tester');
        assertDeepEq(stepsOf(now), ['transcript', 'speakers']);
    },
);
