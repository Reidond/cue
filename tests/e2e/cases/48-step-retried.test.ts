import { assertContains, assertEq, assertNotContains, dialogue, e2eCase, fail, fixture } from '../harness/index.ts';

e2eCase(
    'A step of the notes Workflow that fails once is tried again: the note gets its second pass, a summary and no ' +
        'failure, as if nothing had happened.',
    async (cue) => {
        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        await cue.project('Interviews', { language: 'en' });
        const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
        await cue.launch(
            {
                CUE_PROJECT: 'Interviews',
                CUE_REHEARSE_RECORD: '1',
                // Deepgram's recorded-file API fails the first request it gets; the Workflow tries the step again a second later.
                FAKE_DEEPGRAM_FILE_FAILS: '1',
                CUE_REHEARSE_PARTICIPANT: call.wav('call'),
                FAKE_DEEPGRAM_LIVE: call.live(),
                FAKE_DEEPGRAM_FILE: call.file(),
                CUE_REHEARSE_ME: call.wav('me'),
            },
            { backend: { env: { NOTES_RETRY_SECONDS: '1' } } },
        );
        await cue.waitLog(/Notes ready/, 180);

        const log = cue.sessionLog();
        assertContains(log, /✅ Transcript improved: /);
        assertNotContains(log, /Couldn't improve the transcript/, 'the retry made the failure invisible');
        assertEq(cue.logCount(/🔁 Improving transcript…/), 1, 'the step is one step, however many tries it took');

        // Deepgram was asked again after the failure.
        const asked = cue.serviceRequests('deepgram-file');
        assertEq(asked.filter((request) => request.failed).length, 1, 'exactly one request was made to fail');
        if (asked.length < 3) fail(`the failed request should have been repeated (${asked.length} requests in all)`);

        const account = await (await cue.backend()).accountOf(cue.email);
        const stored = (await account.notes())[0] ?? fail('the account should have the note');
        assertEq(
            stored.steps.some((step) => step.state === 'failed'),
            false,
            JSON.stringify(stored.steps),
        );
        for (const id of ['transcript', 'speakers', 'summary']) {
            assertEq(
                stored.steps.find((step) => step.id === id)?.state,
                'done',
                `the ${id} step should be done: ${JSON.stringify(stored.steps)}`,
            );
        }
        assertContains(cue.readyNotes(), /^## Summary/);
    },
);
