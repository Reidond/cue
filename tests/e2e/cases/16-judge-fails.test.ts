import { assertContains, CLAUDE, dialogue, e2eCase, fixture, needWhisper, skip } from '../harness/index.ts';

e2eCase('When the question judge fails, a question is still answered by its question mark, and the log says why.', async (cue) => {
    needWhisper();
    if (CLAUDE !== 'fake') skip('makes the stand-in claude’s judge fail');

    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.defaults('autoAnswer', true);
    const call = await dialogue(fixture('dialogues', 'question.txt'), cue.path('call'));
    await cue.launch({ CUE_REHEARSE_PARTICIPANT: call.wav('call'), FAKE_CLAUDE_JUDGE_FAILS: '1' });
    await cue.waitLog(/⚠︎ Question judge unavailable \(.*\) — going by question marks/, 60);
    await cue.waitLog(/❓ \*\*Question:\*\* How many hives did you study\?/, 90);
    await cue.waitLog(/Answer\*\* \(/, 60);
    assertContains(cue.save('asked.txt', cue.claudeRequests('ask').join('\n----\n')), /^Question: \[Participant\] How many hives/);
});
