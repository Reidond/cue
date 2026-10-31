import { randomBytes } from 'node:crypto';
import { assertDeepEq, assertEq, e2eCase, startCall } from '../harness/index.ts';

e2eCase(
    'A note the Mac had before it had an account is imported once: its summary, transcript and suggestions as they were, in the ' +
        'project it belongs to, with the audio put next to it; the same note again is not a second note.',
    async (cue) => {
        const backend = await cue.backend();
        const call = await startCall(backend, 'ann@cue.test');
        const imported = {
            stamp: '2026-10-24T11:05:00Z',
            projectId: call.projectId,
            title: 'Weekly sync about the report',
            startedAt: Date.parse('2026-10-24T11:05:00Z'),
            durationSeconds: 720,
            language: 'en',
            speaker: 'Andrii',
            meeting: { title: 'Weekly sync', attendees: ['Olena Mulesa'] },
            participants: ['Andrii', 'Participant'],
            summary: '## Summary\nThe team agreed to send the beekeeping report by Friday.',
            transcriptHeading: 'Transcript',
            transcript: [
                { channel: 'others', speaker: null, label: 'Participant', start: 12, text: 'When is the report due?' },
                { channel: 'me', speaker: null, label: 'Andrii', start: 15, text: 'By Friday.' },
            ],
            suggestions: { Participant: 'Olena Mulesa' },
        };
        const first = await backend.call('POST', '/v1/notes/import', call.token, { body: imported });
        assertEq(first.status, 201, JSON.stringify(first.body));
        const note = first.body;
        assertEq(note.status, 'ready', 'an imported note has nothing left to make');
        assertEq(note.callId === null, true);
        assertEq(note.projectId, call.projectId);
        assertEq(note.title, imported.title);
        assertEq(note.startedAt, imported.startedAt);
        assertEq(note.durationSeconds, 720);
        assertDeepEq(note.meeting, imported.meeting);
        assertDeepEq(note.participants, imported.participants);
        assertEq(note.summary, imported.summary);
        assertDeepEq(note.transcript, imported.transcript);
        assertDeepEq(note.suggestions, imported.suggestions);
        assertDeepEq(note.audio, []);

        // Again: the same note.
        const again = await backend.call('POST', '/v1/notes/import', call.token, { body: { ...imported, summary: 'Changed.' } });
        assertEq(again.status, 200);
        assertEq(again.body.id, note.id);
        assertEq(again.body.summary, imported.summary, 'the first import stands');
        assertEq((await backend.call('GET', `/v1/notes?project=${call.projectId}`, call.token)).body.notes.length, 1);

        // Its audio goes up as the body, and is served like any other; it is the mixed audio only.
        const audio = randomBytes(50_000);
        const put = await fetch(new URL(`/v1/notes/${note.id}/audio/mixed`, backend.url), {
            method: 'PUT',
            headers: { authorization: `Bearer ${call.token}`, 'content-type': 'audio/mp4' },
            body: audio,
        });
        assertEq(put.status, 200, await put.clone().text());
        const played = await fetch(new URL(`/v1/notes/${note.id}/audio/mixed`, backend.url), {
            headers: { authorization: `Bearer ${call.token}`, range: 'bytes=10-19' },
        });
        assertEq(played.status, 206);
        assertEq(Buffer.from(await played.arrayBuffer()).equals(audio.subarray(10, 20)), true);
        const wrongSide = await fetch(new URL(`/v1/notes/${note.id}/audio/me`, backend.url), {
            method: 'PUT',
            headers: { authorization: `Bearer ${call.token}` },
            body: audio,
        });
        assertEq(wrongSide.status, 400, 'only the mixed audio can be added');

        // A note belongs to a project of the person importing it.
        await backend.invite('bob@cue.test');
        const bob = (await backend.tokensFor('bob@cue.test')).access_token;
        const foreign = await backend.call('POST', '/v1/notes/import', bob, { body: { ...imported, stamp: '2026-10-25T09:00:00Z' } });
        assertEq(foreign.status, 404, "someone else's project does not exist");
    },
);
