import {
    accountProject,
    assertTextContains,
    assertTextNotContains,
    bursts,
    e2eCase,
    fixture,
    LIVE_SCRIPT,
    RECORDED_SCRIPT,
    windowText,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: the Notes page, open while a new note is made, follows it to the ready note (its steps, then the title and the summary from the ' +
        'account), also when Cue is stopped meanwhile.',
    async (cue) => {
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        const others = await bursts(cue.path('others.wav'), 12, [
            [1, 3.5],
            [8, 10],
        ]);
        const me = await bursts(cue.path('me.wav'), 12, [[5, 6.5]]);
        await cue.launch({
            CUE_PROJECT: 'Bees',
            CUE_REHEARSE_RECORD: '1',
            CUE_REHEARSE_PARTICIPANT: others,
            CUE_REHEARSE_ME: me,
            FAKE_DEEPGRAM_LIVE: LIVE_SCRIPT,
            FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT,
            // A second pass that takes a while, as it does for a long call: Cue is stopped while the page shows it.
            FAKE_DEEPGRAM_FILE_DELAY: '8',
        });
        await cue.waitLog(/⏹ Recording stopped/, 120);
        // Stop opened the note on the dashboard; the page shows its steps as they go.
        await cue.waitLog(/🔁 Improving transcript…/, 60);
        await cue.waitFor('the page to show the second pass under way', 30, async () =>
            /^Improving transcript$/m.test(await windowText(cue.pid)),
        );
        cue.save('notes-page-improving.txt', await windowText(cue.pid));

        // Stop Cue, as the person does once the call is over: the page around the note redraws, and the note goes on being made.
        cue.control('stop');
        await cue.waitLog(/⏹ Cue stopped/, 30);
        await cue.waitLog(/📝 Notes ready/, 120);

        // The page follows the note to the end by itself (nothing opens it again): the account's title and summary, no steps left.
        await cue.waitFor('the page to show the ready note', 20, async () => {
            const page = await windowText(cue.pid);
            return /^E2E rehearsal notes$/m.test(page) && !/^Improving transcript$/m.test(page);
        });
        const page = await windowText(cue.pid);
        cue.save('notes-page-ready.txt', page);
        assertTextContains(page, /^Summary$/);
        assertTextContains(page, /^Participant 2$/, 'the second pass told the voices apart');
        assertTextNotContains(page, /^Saving audio$/, 'the steps leave the page once nothing failed');
        assertTextNotContains(page, /^Call /, "the live transcript's title gave way to the account's");
    },
);
