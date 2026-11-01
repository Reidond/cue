import { assertContains, assertEq, assertNotContains, countLines, dialogue, e2eCase, fail, fixture, matches } from '../harness/index.ts';

e2eCase(
    "When the second pass can't run (here Deepgram refuses the first eight requests: four tries of both sides), the voices " +
        'on the call side are still told apart, on the live transcript, from a second reading of the call side alone; the ' +
        'transcript step says what went wrong, and the summary is written all the same.',
    async (cue) => {
        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        await cue.project('Library', { language: 'en' });
        const call = await dialogue(fixture('dialogues', 'two-voices.txt'), cue.path('call'));
        await cue.launch(
            {
                CUE_PROJECT: 'Library',
                CUE_REHEARSE_RECORD: '1',
                FAKE_DEEPGRAM_FILE_FAILS: '8',
                CUE_SNAPSHOT: cue.path('cue.png'),
                CUE_REHEARSE_PARTICIPANT: call.wav('call'),
                FAKE_DEEPGRAM_LIVE: call.live(),
                FAKE_DEEPGRAM_FILE: call.file(),
                CUE_REHEARSE_ME: call.wav('me'),
            },
            { backend: { env: { NOTES_RETRY_SECONDS: '1' } } },
        );
        await cue.waitLog(/Notes ready/, 300);

        const log = cue.sessionLog();
        const steps = matches(
            log,
            /Improving transcript…|Couldn't improve the transcript|Finding speakers…|Speakers: [0-9]+|Writing summary…|Notes ready/,
        ).join(',');
        assertEq(
            steps,
            "Improving transcript…,Couldn't improve the transcript,Finding speakers…,Speakers: 2,Writing summary…,Notes ready",
            `the voices should be found after the failed step, and the summary written: ${steps}`,
        );
        assertContains(log, /⚠︎ Couldn't improve the transcript: .+ — the live transcript is kept$/);
        assertNotContains(log, /Transcript improved/);

        // The live transcript, with the voices told apart: two people on the call side, in the order they first speak.
        const notes = cue.readyNotes();
        assertContains(notes, /^participants: Andrii Test, Participant 1, Participant 2$/);
        assertEq(countLines(notes, /^\*\*[0-9:]+ · Participant 1\*\*$/) > 0, true, 'Participant 1 should have lines');
        assertEq(countLines(notes, /^\*\*[0-9:]+ · Participant 2\*\*$/) > 0, true, 'Participant 2 should have lines');
        assertContains(notes, /survey summary before then/);
        assertContains(notes, /^## Summary/);

        // The account's note says the same.
        const account = await (await cue.backend()).accountOf(cue.email);
        const stored = (await account.notes())[0] ?? fail('the account should have the note');
        assertEq(stored.steps.find((step) => step.id === 'transcript')?.state, 'failed');
        assertEq(stored.steps.find((step) => step.id === 'speakers')?.state, 'done');

        // The note's page keeps the failed step, with what went wrong.
        await cue.dashboardPage('Library/notes', /live transcript is kept/);
        const page = cue.page;
        assertContains(page, /Improving transcript$/);
        assertContains(page, /Finding speakers$/);
        assertContains(page, /Writing summary$/);
        assertContains(page, /^Summary$/);
    },
);
