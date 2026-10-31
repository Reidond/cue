import { assertDeepEq, assertEq, e2eCase, getNote, makeNotes, RECORDED_SCRIPT, recordCall, waitForNote } from '../harness/index.ts';

e2eCase(
    "A recording's audio is deleted from storage once the retention period in the admin's settings has passed since its notes were " +
        'ready; the notes stay, and the audio is not found any more.',
    async (cue) => {
        cue.standIns({ FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT });
        const owner = 'owner@cue.test';
        // A "day" of retention is 20 seconds here, and the janitor looks every second.
        const backend = await cue.backend({ adminEmails: [owner], env: { RETENTION_DAY_SECONDS: '20', RETENTION_TICK_SECONDS: '1' } });
        const admin = await backend.adminAs(owner);
        const set = await admin.call('PATCH', '/settings', { audioRetentionDays: 1 });
        assertEq(set.status, 200, JSON.stringify(set.body));

        const recorded = await recordCall(cue, backend, 'ann@cue.test');
        const started = await makeNotes(backend, recorded);
        const ready = await waitForNote(cue, backend, recorded.token, started.id);
        assertDeepEq([...ready.audio].sort(), ['me', 'others'], 'the audio is in storage when the notes are ready');
        assertEq(backend.objects().length, 2);
        const audio = () =>
            fetch(new URL(`/v1/notes/${ready.id}/audio/others`, backend.url), { headers: { authorization: `Bearer ${recorded.token}` } });
        const before = await audio();
        assertEq(before.status, 200);
        await before.arrayBuffer();

        // Once the period is over the audio goes — all of it — and nothing else of the note.
        await cue.waitFor('the audio to be deleted', 90, async () => (await getNote(backend, recorded.token, ready.id)).audio.length === 0);
        assertEq((await audio()).status, 404, 'the audio is not found any more');
        assertEq(backend.objects().length, 0, 'no object is left in storage');
        const after = await getNote(backend, recorded.token, ready.id);
        assertEq(after.status, 'ready');
        assertDeepEq(after.transcript, ready.transcript, 'the notes themselves stay');
        assertEq(after.summary, ready.summary);
    },
);
