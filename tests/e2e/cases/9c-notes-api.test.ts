import {
    assertDeepEq,
    assertEq,
    assertBetween,
    e2eCase,
    fail,
    fixture,
    getNote,
    makeNotes,
    RECORDED_SCRIPT,
    recordCall,
    waitForNote,
} from '../harness/index.ts';

e2eCase(
    'The notes a call gets are listed by project, readable, renamed speaker by speaker, applied or dismissed name by name, ' +
        'and moved to the trash; another person sees none of it.',
    async (cue) => {
        cue.standIns({ FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT, FAKE_CLAUDE_SUMMARY: fixture('summaries', 'speaker-names.md') });
        const backend = await cue.backend();
        const first = await recordCall(cue, backend, 'ann@cue.test');
        const started = await makeNotes(backend, first);
        assertEq(started.status, 'processing', 'the Workflow has only just started');
        assertEq(started.callId ?? '', first.callId);
        const note = await waitForNote(cue, backend, first.token, started.id);

        // What the Workflow made: the second pass's two voices told apart, in the order they first speak, and the summary's title and suggestion.
        assertEq(note.status, 'ready');
        assertEq(note.title, 'Reading room plan');
        assertDeepEq(note.participants, ['Andrii', 'Participant 1', 'Participant 2']);
        assertDeepEq(
            note.transcript.map((turn) => [turn.channel, turn.speaker, turn.label, turn.text]),
            [
                ['others', 1, 'Participant 1', 'Good morning. When is the report due?'],
                ['me', null, 'Andrii', 'I will send the report by Friday.'],
                ['others', 2, 'Participant 2', 'Thank you, Olena. See you on Monday.'],
            ],
        );
        assertBetween(note.transcript[0]?.start, 0.5, 1.5, 'each turn starts where it was said in the recording');
        assertBetween(note.transcript[1]?.start, 4.5, 5.5);
        assertBetween(note.transcript[2]?.start, 7.5, 8.5);
        assertDeepEq(note.suggestions, { 'Participant 2': 'Olena Mulesa' }, "only the call's own labels get suggestions");
        assertEq(note.summary.includes('<!--'), false, 'the suggestion lines are not part of the summary');
        assertEq(note.summary.startsWith('# '), false, 'the title is not part of the summary');
        assertEq(note.transcriptHeading, 'Transcript');
        assertEq(note.language, 'en');
        assertEq(note.meeting === null, true, 'a call with no calendar event has no meeting');

        // The same recording again is the same note.
        const twice = await backend.call('POST', `/v1/calls/${first.callId}/notes`, first.token, {
            body: {
                take: first.take,
                endedAt: first.endedAt,
                sides: ['me', 'others'],
                speaker: 'Andrii',
                keepAudio: true,
                summarize: true,
            },
        });
        assertEq(twice.status, 200);
        assertEq(twice.body.id, note.id);

        // Lists: all of them, a project's.
        const listed = await backend.call('GET', '/v1/notes', first.token);
        assertDeepEq(
            listed.body.notes.map((item: { id: string }) => item.id),
            [note.id],
        );
        const inProject = await backend.call('GET', `/v1/notes?project=${first.projectId}`, first.token);
        assertEq(inProject.body.notes.length, 1);
        const other = await backend.call('POST', '/v1/projects', first.token, { body: { name: 'Elsewhere' } });
        const inOther = await backend.call('GET', `/v1/notes?project=${other.body.id}`, first.token);
        assertEq(inOther.body.notes.length, 0, "another project has none of this project's notes");

        // Another person sees nothing, and can change nothing: it is not theirs, so it does not exist.
        await backend.invite('bob@cue.test');
        const bob = (await backend.tokensFor('bob@cue.test')).access_token;
        assertEq((await backend.call('GET', '/v1/notes', bob)).body.notes.length, 0);
        for (const [method, path, body] of [
            ['GET', `/v1/notes/${note.id}`, undefined],
            ['PATCH', `/v1/notes/${note.id}`, { dismiss: 'Participant 2' }],
            ['DELETE', `/v1/notes/${note.id}`, undefined],
            ['GET', `/v1/notes/${note.id}/audio/others`, undefined],
            ['GET', `/v1/notes/${note.id}/events`, undefined],
            ['POST', `/v1/calls/${first.callId}/recording/me?take=${first.take}`, undefined],
        ] as const) {
            const refused = await backend.call(method, path, bob, { body });
            assertEq(refused.status, 404, `${method} ${path} should be not_found for someone else: ${JSON.stringify(refused.body)}`);
            assertEq(refused.body.error?.code, 'not_found');
        }
        assertEq((await backend.get('/v1/notes')).status, 401, 'no token, no notes');

        // Renaming a person changes whole words only, throughout the note, and drops the name suggested for them.
        const renamed = await backend.call('PATCH', `/v1/notes/${note.id}`, first.token, {
            body: { rename: { from: 'Participant 1', to: 'Petro Ivanenko' } },
        });
        assertEq(renamed.status, 200, JSON.stringify(renamed.body));
        assertDeepEq(renamed.body.participants, ['Andrii', 'Petro Ivanenko', 'Participant 2']);
        assertEq(renamed.body.transcript[0].label, 'Petro Ivanenko');
        assertEq(renamed.body.transcript[2].label, 'Participant 2', 'another participant keeps their label');
        assertEq(renamed.body.summary.includes('Petro Ivanenko opened the call'), true, renamed.body.summary);
        assertEq(renamed.body.summary.includes('Participant 1'), false);
        assertEq(renamed.body.summary.includes('Participant 2'), true);
        assertDeepEq(renamed.body.suggestions, { 'Participant 2': 'Olena Mulesa' }, 'the suggestion for Participant 2 stays');
        // A name with nothing in it changes nothing.
        const empty = await backend.call('PATCH', `/v1/notes/${note.id}`, first.token, {
            body: { rename: { from: 'Participant 2', to: ' , ' } },
        });
        assertEq(empty.status, 200);
        assertDeepEq(empty.body.participants, ['Andrii', 'Petro Ivanenko', 'Participant 2']);

        // Applying a suggestion renames the person to the suggested name; the suggestion goes.
        const applied = await backend.call('PATCH', `/v1/notes/${note.id}`, first.token, { body: { apply: 'Participant 2' } });
        assertEq(applied.status, 200, JSON.stringify(applied.body));
        assertDeepEq(applied.body.participants, ['Andrii', 'Petro Ivanenko', 'Olena Mulesa']);
        assertEq(applied.body.transcript[2].label, 'Olena Mulesa');
        assertDeepEq(applied.body.suggestions, {});
        const stale = await backend.call('PATCH', `/v1/notes/${note.id}`, first.token, { body: { apply: 'Participant 2' } });
        if (stale.status < 400 || stale.status >= 500) fail('a suggestion that is gone cannot be applied', JSON.stringify(stale));
        assertDeepEq(
            (await getNote(backend, first.token, note.id)).participants,
            ['Andrii', 'Petro Ivanenko', 'Olena Mulesa'],
            'it is stored, not only said',
        );

        // Dismissing a suggestion leaves the people as they were (another call, another note).
        const second = await recordCall(cue, backend, 'ann@cue.test');
        const again = await makeNotes(backend, second);
        const ready = await waitForNote(cue, backend, second.token, again.id);
        assertDeepEq(ready.suggestions, { 'Participant 2': 'Olena Mulesa' });
        const dismissed = await backend.call('PATCH', `/v1/notes/${ready.id}`, second.token, { body: { dismiss: 'Participant 2' } });
        assertEq(dismissed.status, 200);
        assertDeepEq(dismissed.body.suggestions, {});
        assertDeepEq(dismissed.body.participants, ['Andrii', 'Participant 1', 'Participant 2']);

        // Move to Trash: the note leaves the list, and its audio goes at once.
        const trashed = await backend.call('DELETE', `/v1/notes/${note.id}`, first.token);
        assertEq(trashed.status, 200);
        assertEq(trashed.body.deleted, note.id);
        assertDeepEq(
            (await backend.call('GET', '/v1/notes', first.token)).body.notes.map((item: { id: string }) => item.id),
            [ready.id],
        );
        assertEq(
            (await backend.call('GET', `/v1/notes/${note.id}/audio/others`, first.token)).status,
            404,
            'the trashed note has no audio',
        );
    },
);
