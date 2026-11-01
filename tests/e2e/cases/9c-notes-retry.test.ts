import { assertContains, assertEq, e2eCase, makeNotes, noteEvents, RECORDED_SCRIPT, recordCall, waitForNote } from '../harness/index.ts';

e2eCase(
    'A step of the notes Workflow that fails once is tried again, on its own, after the delay: the note comes out whole, and the ' +
        'step reports one start and no failure.',
    async (cue) => {
        // Deepgram's recorded-file API refuses the first request it gets.
        cue.standIns({ FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT, FAKE_DEEPGRAM_FILE_FAILS: '1' });
        const backend = await cue.backend({ env: { NOTES_RETRY_SECONDS: '1' } });
        const recorded = await recordCall(cue, backend, 'ann@cue.test');
        const started = await makeNotes(backend, recorded);
        const note = await waitForNote(cue, backend, recorded.token, started.id);

        const requests = cue.serviceRequests('deepgram-file');
        assertEq(requests.filter((request) => request.failed).length, 1, 'one request was refused');
        assertEq(requests.length >= 3, true, `the step asked again after the refusal (${requests.length} requests)`);
        assertEq(
            note.steps.some((step) => step.state === 'failed'),
            false,
            JSON.stringify(note.steps),
        );
        assertEq(note.steps.find((step) => step.id === 'transcript')?.state, 'done');
        assertContains(cue.save('transcript.txt', note.transcript.map((turn) => turn.text).join('\n')), /When is the report due\?/);

        const lines = (await noteEvents(backend, recorded.token, note.id)).flatMap((event) => (event.line === null ? [] : [event.line]));
        assertEq(lines.filter((line) => line.startsWith('🔁')).length, 1, 'the step starts once, however many tries it takes');
        assertEq(
            lines.some((line) => line.startsWith('⚠︎')),
            false,
            JSON.stringify(lines),
        );
    },
);
