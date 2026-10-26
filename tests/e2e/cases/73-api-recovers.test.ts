import { ANTHROPIC, assertEq, e2eCase, skip } from '../harness/index.ts';

e2eCase('When the Anthropic API fails for a passing reason (overload, the network) as Cue starts, the question judge '
    + 'says so, goes by question marks meanwhile, and is ready again once the API answers.', async (cue) => {
    if (ANTHROPIC !== 'fake') skip('needs the stand-in to be overloaded on purpose');

    await cue.defaults('claudeProvider', 'anthropicAPI');
    await cue.apiKey('anthropic');
    // Three tries at the start (the first and two more, a second and two apart), all overloaded.
    await cue.launch({ FAKE_ANTHROPIC_OVERLOADED: '3' });
    await cue.waitLog(/⚠︎ Question judge unavailable \(The Anthropic API is overloaded — try again in a moment\) — going by question marks/, 20);
    await cue.waitLog(/🧐 Question judge ready: Claude Haiku/, 30);
    const warmups = cue.serviceRequests('anthropic-request').filter((request) => request.kind === 'judge' && request.maxTokens === 0);
    assertEq(warmups.length, 4, 'three overloaded tries, then the one 15 s later that got through');
});
