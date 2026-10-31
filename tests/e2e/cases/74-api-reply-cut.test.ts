import { ANTHROPIC, assertContains, assertEq, e2eCase, fail, skip } from '../harness/index.ts';

e2eCase(
    "An answer the Anthropic API breaks off partway is reported as failed, and isn't kept as part of the " +
        'conversation the next question is asked in.',
    async (cue) => {
        if (ANTHROPIC !== 'fake') skip('needs the stand-in to break a reply off on purpose');

        await cue.defaults('claudeProvider', 'anthropicAPI');
        await cue.apiKey('anthropic');
        await cue.launch({ FAKE_ANTHROPIC_CUT: '1', FAKE_CLAUDE_ANSWER: 'We studied 48 hives on six rooftops over two summers.' });
        await cue.waitLog(/🧐 Question judge ready: Claude Haiku/, 20);

        cue.control('ask How many hives did you study?');
        await cue.waitLog(/Answer\*\* \(/, 30);
        assertContains(cue.sessionLog(), /^⚠︎ The Anthropic API's reply broke off before the end/);

        cue.control('ask Where were the hives?');
        await cue.waitFor('the second answer', 30, () => cue.logCount(/Answer\*\* \(/) >= 2);
        assertContains(cue.sessionLog(), /^We studied 48 hives on six rooftops over two summers\.$/);
        const asked = cue.serviceRequests('anthropic-request').filter((request) => request.kind === 'answer' && request.maxTokens > 0);
        assertEq(asked.length, 2, "a reply that broke off after its first words isn't asked again");
        const second = asked[1] ?? fail('the second question should go to the API');
        assertEq(second.messages, 1, 'the broken-off answer stays out of the conversation: the second question is its only message');
    },
);
