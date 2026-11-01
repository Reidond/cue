import {
    assertDeepEq,
    assertEq,
    e2eCase,
    fixture,
    LIVE_SCRIPT,
    makeNotes,
    noteEvents,
    RECORDED_SCRIPT,
    recordCall,
    waitForNote,
} from '../harness/index.ts';

e2eCase(
    'A step of the notes Workflow that keeps failing (after its tries) leaves the note what it had — the live transcript — and says ' +
        'what failed; the steps after it still run, and a summary that fails leaves the note without one, and says so.',
    async (cue) => {
        // The second pass fails for good: Deepgram's recorded-file API refuses every request (the first 99 are plenty).
        cue.standIns({ FAKE_DEEPGRAM_LIVE: LIVE_SCRIPT, FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT, FAKE_DEEPGRAM_FILE_FAILS: '99' });
        const backend = await cue.backend({ env: { NOTES_RETRY_SECONDS: '1' } });
        const recorded = await recordCall(cue, backend, 'ann@cue.test', { live: true });
        const started = await makeNotes(backend, recorded);
        const note = await waitForNote(cue, backend, recorded.token, started.id);

        assertEq(note.status, 'ready', 'a failed step does not stop the notes');
        const transcript = note.steps.find((step) => step.id === 'transcript');
        assertEq(transcript?.state, 'failed');
        assertEq((transcript?.detail ?? '').includes('live transcript is kept'), true, `it says what is kept: ${transcript?.detail}`);
        assertEq(note.steps.find((step) => step.id === 'summary')?.state, 'done', 'the summary is written from what the note has');
        assertDeepEq(
            note.transcript.map((turn) => turn.text),
            ['Good morning, when is the report?', 'I will send it by Friday.', 'Thank you, Olena. See you Monday.'],
            'the live transcript, as live recognition heard it',
        );
        assertEq(note.title, 'E2E rehearsal notes');
        const events = await noteEvents(backend, recorded.token, note.id);
        const lines = events.flatMap((event) => (event.line === null ? [] : [event.line]));
        assertEq(
            lines.some((line) => /^⚠︎ Couldn't improve the transcript: .+ — the live transcript is kept$/.test(line)),
            true,
            JSON.stringify(lines),
        );
        assertEq(
            lines.some((line) => line.startsWith('✅ Transcript improved')),
            false,
        );

        // A summary that fails for good leaves the note without one (another call; Deepgram is well again).
        cue.standIns({
            FAKE_DEEPGRAM_FILE_FAILS: '0',
            FAKE_ANTHROPIC_SUMMARY_FAILS: '99',
            FAKE_CLAUDE_SUMMARY: fixture('summaries', 'speaker-names.md'),
        });
        const second = await recordCall(cue, backend, 'ann@cue.test');
        const noSummary = await waitForNote(cue, backend, second.token, (await makeNotes(backend, second)).id);
        assertEq(noSummary.summary, '');
        const failed = noSummary.steps.find((step) => step.id === 'summary');
        assertEq(failed?.state, 'failed');
        assertEq(noSummary.steps.find((step) => step.id === 'transcript')?.state, 'done', 'the second pass was not affected');
        assertEq(noSummary.transcript.length, 3, 'the transcript is there all the same');
        const summaryLines = (await noteEvents(backend, second.token, noSummary.id)).flatMap((event) =>
            event.line === null ? [] : [event.line],
        );
        assertEq(
            summaryLines.some((line) => line.startsWith('⚠︎ Summary failed: ')),
            true,
            JSON.stringify(summaryLines),
        );
    },
);
