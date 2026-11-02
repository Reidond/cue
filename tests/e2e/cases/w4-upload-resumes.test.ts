import {
    accountProject,
    assertBetween,
    assertContains,
    assertEq,
    assertFile,
    bursts,
    e2eCase,
    fail,
    fixture,
    matches,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: a recording whose upload is interrupted partway (here the connection is lost after your side has gone up) carries on from what the ' +
        'backend has: the whole recording reaches it, and the notes still come, with the second pass.',
    async (cue) => {
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        const others = await bursts(cue.path('others.wav'), 7, [[1, 3.5]]);
        const me = await bursts(cue.path('me.wav'), 7, [[4.5, 6]]);
        await cue.launch({
            CUE_PROJECT: 'Bees',
            CUE_REHEARSE_RECORD: '1',
            // The connection is lost once, after the first part has been sent (your side's): the call side's upload starts over and carries on.
            CUE_UPLOAD_BREAK: '1',
            CUE_REHEARSE_PARTICIPANT: others,
            CUE_REHEARSE_ME: me,
            FAKE_DEEPGRAM_LIVE: JSON.stringify([{ text: 'Good morning, when is the report?', speaker: 0 }, 'I will send it by Friday.']),
            FAKE_DEEPGRAM_FILE: JSON.stringify({
                me: ['I will send the report by Friday.'],
                others: [{ text: 'Good morning. When is the report due?', speaker: 0 }],
            }),
        });
        // Cue is stopped while the call is recorded: the recording goes on (the audio and the call stay open), and since no live call is left by the
        // time it is saved, the recording gets a call of its own just for its notes.
        await cue.waitLog(/⏺ Recording started/, 120);
        cue.control('stop');
        await cue.waitLog(/⏹ Cue stopped/, 20);
        await cue.waitLog(/Notes ready/, 180);

        // The log: the upload starts, stops, goes on and finishes, before the second pass.
        const log = cue.sessionLog();
        const steps = matches(
            log,
            /Uploading the recording…|The upload stopped|Recording uploaded|Improving transcript…|Transcript improved|Notes ready/,
        ).join(',');
        assertEq(
            steps,
            'Uploading the recording…,The upload stopped,Recording uploaded,Improving transcript…,Transcript improved,Notes ready',
            `the upload should stop once, be tried again, and finish before the second pass: ${steps}`,
        );
        assertContains(log, /⚠︎ The upload stopped: .+ — trying again$/);
        assertEq(
            matches(log, /Cue stopped|Recording stopped|Listening stopped/).join(','),
            'Cue stopped,Recording stopped,Listening stopped',
        );

        // The notes belong to a call made just for them: a row that began and ended in the same moment.
        const account = await (await cue.backend()).accountOf(cue.email);
        const note = (await account.notes())[0] ?? fail('the account should have the note');
        const calls = await (await cue.backend()).rows(`SELECT started_at = ended_at AS notes_only FROM call WHERE id = '${note.callId}'`);
        assertEq(Number(calls[0]?.['notes_only']), 1, 'a recording with no live call left makes one just for its notes');

        // Everything arrived: the second pass read a whole recording of each side, as long as the call.
        const asked = cue.serviceRequests('deepgram-file');
        assertEq(asked.length, 2, 'both sides should be read once');
        for (const request of asked) assertBetween(request.seconds, 8, 13, `the whole ${request.side} recording should have gone up`);

        // The second pass's transcript is the one in the note.
        const notes = cue.readyNotes();
        assertFile(notes);
        assertContains(notes, /^\*\*00:00:04 · Andrii Test\*\*$/);
        assertContains(notes, /^## Summary/);
        assertContains(log, /✅ Transcript improved/);
    },
);
