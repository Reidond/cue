import {
    assertContains,
    assertEq,
    assertFile,
    assertNotContains,
    dialogue,
    e2eCase,
    fail,
    fixture,
    matches,
    readText,
} from '../harness/index.ts';

e2eCase(
    "When a step of the notes Workflow keeps failing (here Deepgram's recorded-file API), the note keeps the live " +
        'transcript, its page and the session log say what went wrong, and the summary is written all the same.',
    async (cue) => {
        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        await cue.project('Interviews', { language: 'en' });
        const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
        await cue.launch(
            {
                CUE_PROJECT: 'Interviews',
                CUE_REHEARSE_RECORD: '1',
                FAKE_DEEPGRAM_FILE_FAILS: '99',
                CUE_SNAPSHOT: cue.path('cue.png'),
                CUE_REHEARSE_PARTICIPANT: call.wav('call'),
                FAKE_DEEPGRAM_LIVE: call.live(),
                FAKE_DEEPGRAM_FILE: call.file(),
                CUE_REHEARSE_ME: call.wav('me'),
            },
            // The Workflow retries a failing step before it gives up; a second between tries keeps the case short.
            { backend: { env: { NOTES_RETRY_SECONDS: '1' } } },
        );
        await cue.waitLog(/Notes ready/, 180);

        const log = cue.sessionLog();
        assertContains(log, /⚠︎ Couldn't improve the transcript: .+ — the live transcript is kept$/);
        assertNotContains(log, /Transcript improved/);
        const steps = matches(
            log,
            /Transcript saved|Improving transcript…|Couldn't improve the transcript|Finding speakers…|Couldn't tell speakers apart|Writing summary…|Notes ready/,
        ).join(',');
        // Finding the voices on the call side reads the recording again, which fails the same way: that step says so too, and moves on.
        assertEq(
            steps,
            "Transcript saved,Improving transcript…,Couldn't improve the transcript,Finding speakers…,Couldn't tell speakers apart,Writing summary…,Notes ready",
            `the summary should still be written after the failed step: ${steps}`,
        );
        // The step was tried again before the Workflow gave up.
        const tries = cue.serviceRequests('deepgram-file').length;
        if (tries < 4) fail(`the failing step should have been retried, Deepgram was asked ${tries} time(s)`);

        // The note has the live transcript: every line the live recognition heard, as it heard it.
        const notes = cue.readyNotes();
        assertFile(notes);
        const live = matches(log, /\*\*\[(Participant|Andrii Test)\]\*\* .*/).map((line) => line.replace(/^\*\*\[[^\]]+\]\*\* /, ''));
        cue.save('live.txt', live.map((line) => `${line}\n`).join(''));
        assertEq(live.length, 4, 'live recognition should have heard the four lines');
        const text = readText(notes) ?? '';
        for (const line of live) {
            if (!text.includes(line)) fail(`the note should keep the live line: ${line}`);
        }
        assertContains(notes, /^\*\*00:00:05 · Andrii Test\*\*$/);

        // The summary is there, and the note is named after it.
        assertContains(notes, /^## Summary/);
        assertContains(notes, /^title: "E2E rehearsal notes"/);

        // The account's note says the same: the step failed, and why.
        const account = await (await cue.backend()).accountOf(cue.email);
        const stored = (await account.notes())[0] ?? fail('the account should have the note');
        const step = stored.steps.find((item) => item.id === 'transcript');
        assertEq(step?.state, 'failed');
        assertEq((step?.detail ?? '') !== '', true, 'the failed step should say why');
        assertEq(stored.steps.find((item) => item.id === 'summary')?.state, 'done');

        // The note's page keeps its steps, with what went wrong.
        await cue.dashboardPage('Interviews/notes', /transcript is kept/);
        const page = cue.page;
        assertContains(page, /Saving audio$/);
        assertContains(page, /Improving transcript$/);
        assertContains(page, /Writing summary$/);
        assertContains(page, /^Summary$/);
    },
);
