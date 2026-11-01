import {
    assertBetween,
    assertContains,
    assertEq,
    assertFile,
    audioLength,
    dialogue,
    e2eCase,
    fail,
    fixture,
    matches,
} from '../harness/index.ts';

e2eCase(
    'A recording whose upload is interrupted partway (here the connection is lost after your side has gone up) carries on ' +
        'from what the backend has: the whole recording reaches it, and the notes still come, with the second pass.',
    async (cue) => {
        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        await cue.project('Interviews', { language: 'en' });
        const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
        await cue.launch({
            CUE_PROJECT: 'Interviews',
            CUE_REHEARSE_RECORD: '1',
            // The connection is lost once, after the first part has been sent (your side's): the call side's upload starts over and carries on.
            CUE_UPLOAD_BREAK: '1',
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            FAKE_DEEPGRAM_LIVE: call.live(),
            FAKE_DEEPGRAM_FILE: call.file(),
            CUE_REHEARSE_ME: call.wav('me'),
        });
        await cue.waitLog(/Notes ready/, 180);

        // The log: the upload starts, stops, resumes and finishes, before the second pass.
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

        // Everything arrived, in the right order: Deepgram got a whole recording of each side, as long as the call.
        const callLength = (await audioLength(call.wav('call'))) ?? fail("afinfo can't read the call's length");
        const asked = cue.serviceRequests('deepgram-file');
        assertEq(asked.length, 2, 'both sides should be read once');
        for (const request of asked)
            assertBetween(request.seconds, callLength + 2, callLength + 8, `the whole ${request.side} recording should have gone up`);

        // The second pass's transcript is the one in the note.
        const notes = cue.readyNotes();
        assertFile(notes);
        assertContains(notes, /^\*\*00:00:05 · Andrii Test\*\*$/);
        assertContains(notes, /^## Summary/);
        assertContains(log, /✅ Transcript improved/);
    },
);
