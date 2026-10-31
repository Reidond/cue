import { assertContains, assertEq, e2eCase, fail } from '../harness/index.ts';

e2eCase(
    "An answer Claude's connection breaks off partway is reported as failed, and isn't kept as part of the conversation the next question is asked in.",
    async (cue) => {
        await cue.project('Bees', { language: 'en' });
        await cue.launch({ CUE_PROJECT: 'Bees', FAKE_ANTHROPIC_CUT: '1', FAKE_CLAUDE_ANSWER: 'We studied 48 hives on six rooftops over two summers.' });
        cue.control('start Bees');
        await cue.waitLog(/🧐 Question judge ready: Claude Haiku/, 30);

        cue.control('ask How many hives did you study?');
        await cue.waitLog(/Answer\*\* \(/, 30);
        assertContains(cue.sessionLog(), /^⚠︎ Claude's reply broke off before the end/);

        cue.control('ask Where were the hives?');
        await cue.waitFor('the second answer', 30, () => cue.logCount(/Answer\*\* \(/) >= 2);
        assertContains(cue.sessionLog(), /^We studied 48 hives on six rooftops over two summers\.$/);
        const asked = cue.serviceRequests('anthropic-request').filter((request) => request.kind === 'answer' && request.maxTokens > 0);
        assertEq(asked.length, 2, "a reply that broke off after its first words isn't asked again");
        const second = asked[1] ?? fail('the second question should reach Claude');
        assertEq(second.messages, 1, 'the broken-off answer stays out of the conversation: the second question is its only message');
    },
);
