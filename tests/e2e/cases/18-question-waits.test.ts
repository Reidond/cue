import { assertEq, CLAUDE, dialogue, e2eCase, fail, fixture, needWhisper, readText, skip, sleep } from '../harness/index.ts';

e2eCase('A question is answered once the participant has finished, even after the speaker murmured over an earlier remark.', async (cue) => {
    needWhisper();
    if (CLAUDE !== 'fake') skip('slows the stand-in claude’s judge down');

    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.defaults('autoAnswer', true);
    const call = await dialogue(fixture('dialogues', 'murmur-then-question.txt'), cue.path('call'));
    // A slow judge keeps each verdict pending while the next words are said.
    await cue.launch({ CUE_REHEARSE_PARTICIPANT: call.wav('call'), CUE_REHEARSE_ME: call.wav('me'), FAKE_CLAUDE_JUDGE_DELAY: '3' });
    await cue.waitLog(/❓ \*\*Question:\*\* How many hives/, 120);
    await sleep(6);

    const log = readText(cue.sessionLog()) ?? '';
    assertEq(cue.logCount(/❓/), 1, 'the question should be asked once');
    const explained = log.search(/\*\*\[Participant\]\*\* I am asking because/), asked = log.search(/❓/);
    if (explained < 0 || asked < explained) fail('the question was answered before the participant finished explaining it', log);
});
