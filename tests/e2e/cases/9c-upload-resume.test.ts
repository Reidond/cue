import { readFileSync } from 'node:fs';
import {
    assertBetween,
    assertDeepEq,
    assertEq,
    beginUpload,
    bursts,
    e2eCase,
    fail,
    MIB,
    RECORDED_SCRIPT,
    startCall,
    startNotes,
    uploadRecording,
    waitForNote,
} from '../harness/index.ts';

e2eCase(
    "A recording's upload that loses the connection partway is resumed from the parts that arrived (the half-sent part " +
        'is not among them), completes into one object as long as the recording, and the notes read all of it.',
    async (cue) => {
        cue.standIns({ FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT });
        const backend = await cue.backend();
        const call = await startCall(backend, 'ann@cue.test');
        const take = call.startedAt;

        // Long enough for three parts of 5 MiB on each side (R2's smallest part), speaking where the stand-in's script has its lines.
        const seconds = 340;
        const me = readFileSync(await bursts(cue.path('me.wav'), seconds, [[5, 6.5]]));
        const others = readFileSync(
            await bursts(cue.path('others.wav'), seconds, [
                [1, 3.5],
                [8, 10],
            ]),
        );
        if (others.length < 2 * 5 * MIB) fail(`the recording should span several parts, it is ${others.length} bytes`);

        // The call side loses the connection in the middle of its second part, after 1 MiB of it.
        const sent = await uploadRecording(backend, call.token, call.callId, 'others', others, { take, breakAt: { part: 2, bytes: MIB } });
        assertDeepEq(sent.resumed, [1], 'only the first part had arrived; the half-sent second one had not');
        assertDeepEq(
            sent.attempts,
            [
                { part: 1, ok: true },
                { part: 2, ok: false },
                { part: 2, ok: true },
                { part: 3, ok: true },
            ],
            'the second part is sent again, the first not',
        );
        assertEq(sent.size ?? -1, others.length, 'the object should be as big as the recording');

        // Your side goes up without a break; asking again after it is done says so, with the same upload.
        const mine = await uploadRecording(backend, call.token, call.callId, 'me', me, { take });
        assertEq(
            mine.attempts.every((attempt) => attempt.ok),
            true,
        );
        const again = await beginUpload(backend, call.token, call.callId, 'others', take);
        assertEq(again.status, 'done');
        assertEq(again.uploadId, sent.uploadId, 'the same upload, not a new one');
        assertEq(again.size ?? -1, others.length);

        // The notes read the whole of it: Deepgram got both recordings, intact.
        const started = await startNotes(backend, call.token, call.callId, { take, endedAt: take + seconds * 1000 });
        assertEq(started.status, 202);
        const note = await waitForNote(cue, backend, call.token, started.body.id);
        assertEq(note.steps.find((step) => step.id === 'transcript')?.state, 'done', JSON.stringify(note.steps));
        const asked = cue.serviceRequests('deepgram-file');
        assertEq(asked.length, 2);
        for (const request of asked) assertBetween(request.seconds, seconds - 0.1, seconds + 0.1, `the whole ${request.side} recording`);
        assertEq(
            note.transcript.map((turn) => turn.text).join(' | '),
            'Good morning. When is the report due? | I will send the report by Friday. | Thank you, Olena. See you on Monday.',
        );
    },
);
