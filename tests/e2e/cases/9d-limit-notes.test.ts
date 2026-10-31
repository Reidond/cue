import { assertEq, e2eCase, fixture, LIVE_SCRIPT, makeNotes, noteEvents, RECORDED_SCRIPT, recordCall, waitForNote } from '../harness/index.ts';

const OWNER = 'owner@cue.test';

e2eCase(
    'Notes of a call made over the limit still come, with the live transcript: the second pass and the summary are not bought, and the session log ' +
        'says they were not because of the limit; with the limit raised the next notes get both.',
    async (cue) => {
        cue.standIns({ FAKE_DEEPGRAM_LIVE: LIVE_SCRIPT, FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT, FAKE_CLAUDE_SUMMARY: fixture('summaries', 'speaker-names.md') });
        const backend = await cue.backend({ adminEmails: [OWNER] });
        const recorded = await recordCall(cue, backend, 'ann@cue.test', { live: true });
        // The call is over and the money is gone before the notes start.
        await backend.seedUsage('ann@cue.test', [{ feature: 'answer', usd: 20 }]);

        const started = await makeNotes(backend, recorded);
        const note = await waitForNote(cue, backend, recorded.token, started.id);
        assertEq(note.status, 'ready');
        assertEq(note.transcript.map((turn) => turn.text).join(' '), 'Good morning, when is the report? I will send it by Friday. Thank you, Olena. See you Monday.', 'the live transcript');
        assertEq(note.summary, '', 'no summary');
        for (const id of ['transcript', 'speakers', 'names', 'summary'] as const) {
            const step = note.steps.find((candidate) => candidate.id === id);
            assertEq(step?.state, 'failed', id);
            assertEq((step?.detail ?? '').startsWith('Cue plan limit reached'), true, `${id}: ${step?.detail}`);
        }
        const lines = (await noteEvents(backend, recorded.token, note.id)).flatMap((event) => (event.line === null ? [] : [event.line]));
        assertEq(lines.includes("⚠︎ Cue plan limit reached: the summary wasn't written — the transcript is kept"), true, JSON.stringify(lines));
        assertEq(lines.includes("⚠︎ Cue plan limit reached: the transcript wasn't improved — the live transcript is kept"), true, JSON.stringify(lines));
        assertEq(cue.serviceRequests('deepgram-file').length, 0, 'Deepgram was not asked to read the recording');
        assertEq(cue.serviceRequests('anthropic-request').filter((request) => request.kind === 'summary' || request.kind === 'names').length, 0, 'nor Claude to write');

        // The owner raises the limit: the next notes are the full ones.
        await backend.setLimit(OWNER, 'ann@cue.test', 100);
        const second = await recordCall(cue, backend, 'ann@cue.test');
        const full = await waitForNote(cue, backend, second.token, (await makeNotes(backend, second)).id);
        assertEq(full.steps.every((step) => step.state === 'done'), true, JSON.stringify(full.steps));
        assertEq(full.summary !== '', true, 'with a summary');
    },
);
