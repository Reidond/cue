import { assertContains, assertNotContains, e2eCase, fixture, needRealAnthropic } from '../harness/index.ts';

e2eCase('With the real Anthropic API, the judge is ready and a question about the materials gets an answer from them.', async (cue) => {
    await needRealAnthropic();

    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.defaults('claudeProvider', 'anthropicAPI');
    await cue.apiKey('anthropic');
    await cue.launch();
    await cue.waitLog(/🧐 Question judge ready: Claude Haiku/, 60);
    cue.control('ask How many hives did you study?');
    await cue.waitLog(/Answer\*\* \(first word/, 90);

    const log = cue.sessionLog();
    assertNotContains(log, /^⚠︎ |Answer\*\* .*⚠︎/, 'the answer should not be an error');
    assertContains(log, /48/, 'the answer comes from the materials: 48 hives');
});
