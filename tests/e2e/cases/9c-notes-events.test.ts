import {
    assertDeepEq,
    assertEq,
    assertTextContains,
    e2eCase,
    fixture,
    makeNotes,
    noteEvents,
    RECORDED_SCRIPT,
    recordCall,
    waitForNote,
} from '../harness/index.ts';

e2eCase(
    "A note's progress is followed over server-sent events, one per line of the session log, in order, ending with the note " +
        'being ready; a client that reconnects asks for what came after the last event it saw.',
    async (cue) => {
        cue.standIns({ FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT, FAKE_CLAUDE_SUMMARY: fixture('summaries', 'transcript-remarks.md') });
        const backend = await cue.backend();
        // In Ukrainian, so that the remarks about the transcript in the summary are the ones the lexicon knows.
        const recorded = await recordCall(cue, backend, 'ann@cue.test', { language: 'uk' });
        const started = await makeNotes(backend, recorded);

        // Followed from the start: the stream runs until the note is ready, then ends.
        const events = await noteEvents(backend, recorded.token, started.id);
        const note = await waitForNote(cue, backend, recorded.token, started.id);
        assertDeepEq(
            events.map((event) => event.seq),
            events.map((_, index) => events[0]!.seq + index),
            'sequence numbers count up, one after another',
        );
        const lines = events.flatMap((event) => (event.line === null ? [] : [event.line]));
        const wanted = [
            /^🔁 Improving transcript…$/,
            /^✅ Transcript improved: 3 segments \([0-9.]+ s for 0:[0-9]{2} of audio\)$/,
            /^👥 Finding speakers…$/,
            /^✅ Speakers: 2 \([0-9.]+ s, [0-9]+ stretches of speech\)$/,
            /^✍️ Writing summary…$/,
        ];
        assertDeepEq(
            lines.slice(0, wanted.length).map((line, index) => (wanted[index]!.test(line) ? 'ok' : line)),
            wanted.map(() => 'ok'),
            `the session log's lines, in order: ${JSON.stringify(lines)}`,
        );
        // Remarks about the transcript that the summary made anyway are dropped, and each drop is said.
        assertEq(
            lines.filter((line) => line.startsWith('🧽 Dropped a remark about the transcript from the summary: ')).length,
            4,
            JSON.stringify(lines),
        );
        const last = events.at(-1)!;
        assertEq(last.kind, 'note');
        assertEq(last.state, 'ready');
        assertEq(events.filter((event) => event.kind === 'note').length, 1, 'the note is ready once');
        assertEq(note.steps.find((step) => step.id === 'transcript')?.state, 'done');

        // A reconnecting client: after a sequence number, by ?after= or by Last-Event-ID, gets only what came later.
        const seen = events[2]!.seq;
        const later = events.filter((event) => event.seq > seen);
        assertDeepEq(
            (await noteEvents(backend, recorded.token, started.id, { after: seen })).map((event) => event.seq),
            later.map((event) => event.seq),
        );
        assertDeepEq(
            (await noteEvents(backend, recorded.token, started.id, { lastEventId: seen })).map((event) => event.seq),
            later.map((event) => event.seq),
        );
        // A note that was ready before the client came has its whole story to tell, and then the stream ends.
        assertDeepEq(
            (await noteEvents(backend, recorded.token, started.id)).map((event) => event.seq),
            events.map((event) => event.seq),
        );
        assertTextContains(JSON.stringify(note.steps), /"id":"summary"/);
    },
);
