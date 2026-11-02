import { accountProject, assertEq, assertTextContains, bursts, e2eCase, fixture, press, windowText } from '../harness/index.ts';

e2eCase(
    'Cue for Windows: the Ask field (`ask`) answers a question of the person’s own, Answer now (the overlay’s button) answers the last thing the call said ' +
        'though it was no question, and with Auto off a noticed question waits for Prepare Answer.',
    async (cue) => {
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        // Auto off: what Cue notices waits for Prepare Answer.
        await cue.defaults('autoAnswer', false);
        const call = await bursts(cue.path('call.wav'), 10, [
            [1, 3],
            [6, 8],
        ]);
        await cue.launch({
            CUE_PROJECT: 'Bees',
            CUE_REHEARSE_PARTICIPANT: call,
            FAKE_DEEPGRAM_LIVE: JSON.stringify(['How many hives did you study?', 'Tell us about the winter losses.']),
            FAKE_CLAUDE_ANSWERS: JSON.stringify({
                hives: 'We studied 48 hives.\n- Counted every spring\nSource: talk.md',
                winter: 'Winter losses were 9 percent.\n- Lower than the national average\nSource: talk.md',
                trousers: 'I can only talk about the bees.\n- That is outside the talk',
            }),
        });
        // Noticed with Auto off: listed, not asked.
        await cue.waitLog(/Question \(Auto is off\):\*\* How many hives/, 90);
        await cue.waitLog(/\*\*\[Participant\]\*\* Tell us about the winter losses/, 60);
        let text = await windowText(cue.pid);
        assertTextContains(text, /^Prepare Answer$/, 'Prepare Answer is offered');
        assertTextContains(text, /^How many hives did you study\?$/);
        assertEq(cue.logCount(/❓/), 0, 'nothing should be asked before Prepare Answer');
        assertEq(cue.claudeRequests('ask').length, 0, 'Claude should not be asked yet');

        // Prepare Answer, by the button itself.
        await press(cue.pid, 'Prepare Answer');
        await cue.waitLog(/❓ \*\*Question:\*\* How many hives/, 30);
        await cue.waitLog(/Answer\*\* \(/, 60);
        text = await windowText(cue.pid);
        assertTextContains(text, /^Counted every spring$/, 'the answer shows in full');

        // The Ask field.
        cue.control('ask Why are you wearing trousers?');
        await cue.waitLog(/❓ \*\*Question:\*\* Why are you wearing trousers\?/, 30);
        await cue.waitLog(/I can only talk about the bees\./, 60);
        text = await windowText(cue.pid);
        assertTextContains(text, /^Why are you wearing trousers\?$/, 'the question asked in Ask');
        assertTextContains(text, /^I can only talk about the bees\.$/, 'and its answer, shown at once');

        // Answer now: the last thing the call said was no question; the button answers it all the same.
        await press(cue.pid, 'Answer now');
        await cue.waitLog(/❓ \*\*Question:\*\* Tell us about the winter losses/, 30);
        await cue.waitLog(/Winter losses were 9 percent/, 60);
        text = await windowText(cue.pid);
        assertTextContains(text, /^Winter losses were 9 percent\.$/, 'answered by Answer now');
    },
);
