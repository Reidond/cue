import { accountProject, assertTextContains, assertTextNotContains, bursts, e2eCase, fixture, windowText } from '../harness/index.ts';

e2eCase(
    'Cue for Windows: the answer in view stays while you read it aloud: a question asked meanwhile waits in the New group under it, and its answer ' +
        'comes into view once you pause, the one you read moving to Answered.',
    async (cue) => {
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        // The call asks the first question; you read its answer aloud (your microphone), the call asks another in a breath you take, and you read on.
        const call = await bursts(cue.path('call.wav'), 24, [
            [1, 3],
            [10, 12],
        ]);
        // You read for a while: the case reads the window (a few seconds) before your pause makes the waiting answer show.
        const me = await bursts(cue.path('me.wav'), 24, [[7, 19]]);
        await cue.launch({
            CUE_PROJECT: 'Bees',
            CUE_REHEARSE_PARTICIPANT: call,
            CUE_REHEARSE_ME: me,
            FAKE_DEEPGRAM_LIVE: JSON.stringify([
                'How many hives did you study?',
                'We studied forty eight hives on six rooftops in the city, over two summers, and counted the bees every week.',
                'Which rooftops?',
            ]),
            FAKE_CLAUDE_ANSWERS: JSON.stringify({
                hives: 'We studied 48 hives.\n- Point about hives\nSource: talk.md',
                rooftops: 'We used six rooftops.\n- Point about roofs\nSource: talk.md',
            }),
        });
        await cue.waitLog(/Question:.*hives/, 90);

        // You're reading the first answer when the second question comes: it waits.
        await cue.waitLog(/📖 Waits while you read the answer in view: .*rooftops/, 60);
        const reading = await windowText(cue.pid);
        cue.save('reading.txt', reading);
        assertTextContains(reading, /Point about hives/, 'the answer being read aloud should stay in view');
        assertTextNotContains(reading, /Point about roofs/, 'the new answer should not take its place');
        assertTextContains(reading, /^New$/, 'the new question should wait in the New group');
        assertTextContains(reading, /Which rooftops/, 'as a row under the answer being read');

        // You pause: the waiting answer comes into view by itself.
        await cue.waitLog(/📖 Shown now that you've paused: .*rooftops/, 40);
        await cue.waitFor('the second answer to show', 20, async () => /Point about roofs/.test(await windowText(cue.pid)));
        const shown = await windowText(cue.pid);
        cue.save('shown.txt', shown);
        assertTextContains(shown, /^Answered$/, 'the answer read aloud has moved to Answered');
        assertTextContains(shown, /How many hives/, 'as a row there');
        assertTextNotContains(shown, /^New$/, 'nothing new is left');
    },
);
