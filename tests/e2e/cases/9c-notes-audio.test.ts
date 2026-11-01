import { randomBytes } from 'node:crypto';
import {
    assertDeepEq,
    assertEq,
    e2eCase,
    fail,
    getNote,
    RECORDED_SCRIPT,
    recordCall,
    startNotes,
    uploadRecording,
    waitForNote,
} from '../harness/index.ts';

e2eCase(
    "A note's audio is served from storage with range requests, each side in its own type, so that a client can play from a " +
        'timestamp; a side that was never uploaded is not found.',
    async (cue) => {
        cue.standIns({ FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT });
        const backend = await cue.backend();
        const recorded = await recordCall(cue, backend, 'ann@cue.test');
        const { token, callId, take } = recorded;
        // Both sides to be read, and the mixed audio for playing (here, any bytes: the backend keeps what it is given).
        const mixed = randomBytes(300_000);
        await uploadRecording(backend, token, callId, 'me', recorded.me, { take });
        await uploadRecording(backend, token, callId, 'others', recorded.others, { take });
        await uploadRecording(backend, token, callId, 'mixed', mixed, { take, contentType: 'audio/mp4' });
        const started = await startNotes(backend, token, callId, { take, endedAt: recorded.endedAt, sides: ['me', 'others', 'mixed'] });
        assertEq(started.status, 202);
        const note = await waitForNote(cue, backend, token, started.body.id);
        assertDeepEq([...note.audio].sort(), ['me', 'mixed', 'others'], 'the note lists the audio it has');

        const audio = (side: string, range?: string) =>
            fetch(new URL(`/v1/notes/${note.id}/audio/${side}`, backend.url), {
                headers: { authorization: `Bearer ${token}`, ...(range ? { range } : {}) },
            });

        // The whole file, and a stretch of it.
        const whole = await audio('mixed');
        assertEq(whole.status, 200);
        assertEq(whole.headers.get('content-type') ?? '', 'audio/mp4');
        assertEq(whole.headers.get('accept-ranges') ?? '', 'bytes');
        if (!Buffer.from(await whole.arrayBuffer()).equals(mixed)) fail('the whole file should come back as it went up');

        const part = await audio('mixed', 'bytes=1000-1999');
        assertEq(part.status, 206);
        assertEq(part.headers.get('content-range') ?? '', `bytes 1000-1999/${mixed.length}`);
        if (!Buffer.from(await part.arrayBuffer()).equals(mixed.subarray(1000, 2000))) fail('the range should be those bytes');

        const tail = await audio('mixed', `bytes=${mixed.length - 100}-`);
        assertEq(tail.status, 206);
        assertEq((await tail.arrayBuffer()).byteLength, 100, 'an open range runs to the end');

        // The sides are WAV files; the one played from a timestamp is read the same way.
        const me = await audio('me', 'bytes=0-43');
        assertEq(me.status, 206);
        assertEq(me.headers.get('content-type') ?? '', 'audio/wav');
        assertEq(Buffer.from(await me.arrayBuffer()).toString('ascii', 0, 4), 'RIFF');

        // No audio, no such file.
        const second = await recordCall(cue, backend, 'ann@cue.test');
        const bare = await startNotes(backend, second.token, second.callId, { take: second.take, endedAt: second.endedAt, sides: [] });
        const without = await waitForNote(cue, backend, second.token, bare.body.id);
        assertDeepEq(without.audio, []);
        assertEq(
            (
                await fetch(new URL(`/v1/notes/${without.id}/audio/mixed`, backend.url), {
                    headers: { authorization: `Bearer ${second.token}` },
                })
            ).status,
            404,
        );
        assertEq((await getNote(backend, token, note.id)).audio.length, 3, 'the first note keeps its audio');
    },
);
