import { accountProject, assertEq, assertTextContains, bursts, e2eCase, fixture, windowText } from '../harness/index.ts';

e2eCase(
    'Cue for Windows: when the live socket is lost the call reconnects by itself, goes on over the same call, and nothing it showed is shown twice.',
    async (cue) => {
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        const call = await bursts(cue.path('call.wav'), 40, [
            [1, 3.5],
            [22, 24.5],
        ]);
        await cue.launch({
            CUE_PROJECT: 'Bees',
            // The first connection is lost 12 s after it came up: after the first answer, before the second question.
            CUE_LIVE_BREAK: '12',
            CUE_REHEARSE_PARTICIPANT: call,
            FAKE_DEEPGRAM_LIVE: JSON.stringify(['How many hives did you study?', 'Which rooftops did you use?']),
            FAKE_CLAUDE_ANSWERS: JSON.stringify({
                hives: 'We studied 48 hives.\n- Point about hives\nSource: talk.md',
                rooftops: 'We used six rooftops.\n- Point about roofs\nSource: talk.md',
            }),
        });
        await cue.waitLog(/Answer\*\* \(/, 90);
        await cue.waitLog(/⚠︎ The live call's connection: /, 60);
        // The second question reaches Cue over the new connection.
        await cue.waitLog(/Question:.*rooftops/, 60);
        await cue.waitFor('the second answer', 30, () => cue.logCount(/Answer\*\* \(/) === 2);

        assertEq(cue.logCount(/📞 Live call started/), 1, 'the same call goes on');
        assertEq(cue.logCount(/The live call stopped/), 0, 'it did not end');
        assertEq(cue.logCount(/\*\*\[Participant\]\*\*/), 2, 'each line of the transcript once');
        assertEq(cue.logCount(/❓ \*\*Question:\*\*/), 2, 'each question once');
        assertEq(cue.logCount(/Question judge ready/), 1, 'the statuses are not told again');
        const text = await windowText(cue.pid);
        assertTextContains(text, /^How many hives did you study\?$/);
        assertTextContains(text, /Point about roofs/);
    },
);
