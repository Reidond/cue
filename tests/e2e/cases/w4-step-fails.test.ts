import {
    accountProject,
    assertContains,
    assertEq,
    assertFile,
    assertNotContains,
    assertTextContains,
    bursts,
    e2eCase,
    fail,
    fixture,
    matches,
    readText,
    windowText,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: when a step of the notes Workflow keeps failing (here Deepgram’s recorded-file API), the note keeps the live transcript, its page and ' +
        'the session log say what went wrong, and the summary is written all the same.',
    async (cue) => {
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        const others = await bursts(cue.path('others.wav'), 7, [[1, 3.5]]);
        const me = await bursts(cue.path('me.wav'), 7, [[4.5, 6]]);
        await cue.launch(
            {
                CUE_PROJECT: 'Bees',
                CUE_REHEARSE_RECORD: '1',
                FAKE_DEEPGRAM_FILE_FAILS: '99',
                CUE_REHEARSE_PARTICIPANT: others,
                CUE_REHEARSE_ME: me,
                FAKE_DEEPGRAM_LIVE: JSON.stringify([{ text: 'Good morning, when is the report?', speaker: 0 }, 'I will send it by Friday.']),
                FAKE_DEEPGRAM_FILE: JSON.stringify({ me: ['I will send the report by Friday.'], others: ['Good morning. When is the report due?'] }),
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
        const tries = cue.serviceRequests('deepgram-file').length;
        if (tries < 4) fail(`the failing step should have been retried, Deepgram was asked ${tries} time(s)`);

        // The note has the live transcript: every line the live recognition heard, as it heard it.
        const notes = cue.readyNotes();
        assertFile(notes);
        const live = matches(log, /\*\*\[(Participant|Andrii Test)\]\*\* .*/).map((line) => line.replace(/^\*\*\[[^\]]+\]\*\* /, ''));
        assertEq(live.length, 2, 'live recognition should have heard the two lines');
        const text = readText(notes) ?? '';
        for (const line of live) {
            if (!text.includes(line)) fail(`the note should keep the live line: ${line}`);
        }
        assertContains(notes, /^\*\*00:00:04 · Andrii Test\*\*$/);
        assertContains(notes, /^## Summary/);
        assertContains(notes, /^title: "E2E rehearsal notes"/);

        // The account’s note says the same: the step failed, and why.
        const account = await (await cue.backend()).accountOf(cue.email);
        const stored = (await account.notes())[0] ?? fail('the account should have the note');
        const step = stored.steps.find((item) => item.id === 'transcript');
        assertEq(step?.state, 'failed');
        assertEq((step?.detail ?? '') !== '', true, 'the failed step should say why');
        assertEq(stored.steps.find((item) => item.id === 'summary')?.state, 'done');

        // The note’s page keeps its steps, with what went wrong.
        cue.control('page Bees/notes');
        await cue.waitFor('the steps on the page', 60, async () => /transcript is kept/.test(await windowText(cue.pid)));
        const page = cue.save('page.txt', await windowText(cue.pid));
        const shown = readText(page) ?? '';
        assertTextContains(shown, /^Saving audio$/);
        assertTextContains(shown, /^Improving transcript$/);
        assertTextContains(shown, /^Writing summary$/);
        assertTextContains(shown, /The live transcript is kept\.$/);
        assertTextContains(shown, /^Summary$/);
    },
);
