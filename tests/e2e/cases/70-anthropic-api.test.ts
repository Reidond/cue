import {
    ANTHROPIC, assertContains, assertEq, assertNotContains, e2eCase, exec, fail, FAKE_KEYS, fixture, literal, skip,
} from '../harness/index.ts';

e2eCase('With the Anthropic API picked in Settings › Providers and a key pasted there, questions are answered '
    + 'and judged through the API, and the key is kept in the key store only.', async (cue) => {
    if (ANTHROPIC !== 'fake') skip("checks what the API's stand-in received; 75 asks the real API");

    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.launch({ FAKE_CLAUDE_ANSWER: 'We studied 48 hives on six rooftops.\n- 48 hives, 6 rooftops\nSource: talk.md' });
    await cue.waitLog(/🤖 Claude: Claude Code/, 10);

    // What the clicks in Settings › Providers do: pick the API, paste the key, Save.
    cue.control('settings providers');
    cue.control('provider anthropicAPI');
    cue.control(`key anthropic ${FAKE_KEYS.anthropic}`);
    await cue.waitLog(/🤖 Claude: Anthropic API/, 10);
    await cue.waitLog(/🔑 Anthropic API key saved in the keychain/, 10);
    // The judge was ready through Claude Code; it's ready again through the API.
    await cue.waitFor('the judge to be ready through the API', 30, () => cue.logCount(/🧐 Question judge ready: Claude Haiku/) >= 2);

    cue.control('ask How many hives did you study?');
    await cue.waitLog(/Answer\*\* \(/, 30);
    const log = cue.sessionLog();
    assertContains(log, /We studied 48 hives on six rooftops/);
    assertNotContains(log, /Answer\*\* .*⚠︎|^⚠︎ /, 'the answer should not be an error');

    const requests = cue.serviceRequests('anthropic-request');
    const answers = requests.filter((request) => request.kind === 'answer');
    const warmup = answers.find((request) => request.maxTokens === 0) ?? fail("the answer session should warm the API's cache first");
    const asked = answers.find((request) => request.maxTokens > 0) ?? fail('the question should go to the API');
    assertEq(asked.key, FAKE_KEYS.anthropic, 'the key saved in Settings');
    assertEq(asked.version, '2026-10-21');
    assertEq(asked.model, 'claude-sonnet-5-5');
    assertEq(asked.stream, true, 'answers stream in');
    assertEq(asked.thinking?.type, 'between_tools', 'no thinking before a live answer');
    assertEq(asked.systemCache?.ttl, '1h', 'the materials are cached for an hour');
    assertEq(asked.cache?.ttl, '1h', 'and so is the conversation');
    assertEq(warmup.systemCache?.ttl, '1h');
    assertEq(warmup.cache?.type, undefined, "the warm-up caches the materials only, not its placeholder question");
    const judged = requests.find((request) => request.kind === 'judge')
        ?? fail('the question judge should go through the API too');
    assertEq(judged.model, 'claude-haiku-5-5');
    assertEq(judged.thinking?.type, 'disabled');
    const system = cue.save('answer-system.txt', cue.claudeRequests('answer-system').join(''));
    assertContains(system, /48 hives on 6 rooftops/, "the materials are in the API's system prompt");
    assertContains(cue.save('asked.txt', cue.claudeRequests('ask').join('')), /Question: .*how many hives/);

    // The key: in the key store (the keychain, outside a sandbox), nowhere else.
    assertContains(cue.keysFile, new RegExp(`"anthropic":"${literal(FAKE_KEYS.anthropic)}"`));
    const defaults = await exec('defaults', ['export', cue.domain, '-']);
    assertNotContains(cue.save('defaults.plist', defaults.stdout), new RegExp(literal(FAKE_KEYS.anthropic)), "the key isn't a setting");
    assertNotContains(cue.sessionLog(), new RegExp(literal(FAKE_KEYS.anthropic)), "the key isn't logged");
});
