import { assertContains, assertNotContains, dialogue, e2eCase, fixture } from '../harness/index.ts';

e2eCase("A question asked on the call gets a prepared match and Claude's answer.", async (cue) => {
    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.defaults('autoAnswer', true);
    const call = await dialogue(fixture('dialogues', 'question.txt'), cue.path('call'));
    await cue.launch({
        CUE_REHEARSE_PARTICIPANT: call.wav('call'),
        FAKE_DEEPGRAM_LIVE: call.live(),
        FAKE_CLAUDE_ANSWER: 'We studied 48 hives on six rooftops.\n- 48 hives, 6 rooftops\nSource: talk.md',
    });
    await cue.waitLog(/Question:.*hives/, 90);
    await cue.waitLog(/Answer\*\* \(/, 60);

    const log = cue.sessionLog();
    assertContains(log, /prepared match [0-9]+%/);
    assertNotContains(log, /Answer\*\* .*⚠︎/, 'the answer should not be an error');
    assertContains(log, /We studied 48 hives on six rooftops/);
    const asked = cue.save('asked.txt', cue.claudeRequests('ask').join(''));
    assertContains(asked, /Question: \[Participant\].*how many hives/i);
    const system = cue.save('system.txt', cue.claudeRequests('answer-system').join(''));
    assertContains(system, /48 hives on 6 rooftops/, "materials belong in Claude's prompt");
});
