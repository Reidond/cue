import { ANTHROPIC, assertContains, assertEq, DEEPGRAM, e2eCase, skip } from '../harness/index.ts';

e2eCase("A key the Anthropic API or Deepgram turns down is reported as rejected: the judge goes by question marks, "
    + 'answers say why they failed, and speech recognition is unavailable.', async (cue) => {
    if (ANTHROPIC !== 'fake' || DEEPGRAM !== 'fake') skip('needs the stand-ins, which reject any key but their own');

    await cue.defaults('claudeProvider', 'anthropicAPI');
    await cue.defaults('speechProvider', 'deepgram');
    await cue.apiKey('anthropic', 'sk-ant-revoked-key');
    await cue.apiKey('deepgram', 'revoked-deepgram-key');
    await cue.launch();
    await cue.waitLog(/⚠︎ Question judge unavailable \(The Anthropic API key was rejected — check it in Settings › Providers\) — going by question marks/, 20);
    await cue.waitLog(/⚠︎ Speech recognition unavailable: The Deepgram API key was rejected — check it in Settings › Providers/, 20);

    cue.control('ask How many hives did you study?');
    await cue.waitLog(/Answer\*\* \(/, 30);
    assertContains(cue.sessionLog(), /^⚠︎ The Anthropic API key was rejected/);
    // A rejected key isn't tried again and again.
    const asked = cue.serviceRequests('anthropic-request').filter((request) => request.kind === 'answer' && request.maxTokens > 0);
    assertEq(asked.length, 1, 'one try for the question');
});
