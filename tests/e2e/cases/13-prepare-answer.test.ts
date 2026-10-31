import { assertContains, assertEq, dialogue, e2eCase, fixture } from '../harness/index.ts';

e2eCase('With Auto off a question is listed with Prepare Answer, and answered only once that is clicked.', async (cue) => {
    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.defaults('autoAnswer', false);
    const call = await dialogue(fixture('dialogues', 'question.txt'), cue.path('call'));
    await cue.launch({
        CUE_REHEARSE_PARTICIPANT: call.wav('call'),
        FAKE_DEEPGRAM_LIVE: call.live(),
        CUE_SNAPSHOT: cue.path('cue.png'),
        FAKE_CLAUDE_ANSWER: 'We studied 48 hives on six rooftops.\n- Counted every spring\nSource: talk.md',
    });
    await cue.waitLog(/Question \(Auto is off\):\*\* .*hives/, 90);
    assertEq(cue.logCount(/❓/), 0, 'nothing should be asked before Prepare Answer');
    assertEq(cue.claudeRequests('ask').length, 0, 'Claude should not be asked yet');
    const waiting = cue.save('waiting.txt', await cue.snapshotText(cue.path('cue.png')));
    assertContains(waiting, /How many hives did you study/, 'the question should be listed');
    assertContains(waiting, /^Prepare Answer$/, 'with its Prepare Answer button');

    cue.control('prepare');
    await cue.waitLog(/❓ \*\*Question:\*\* .*hives/, 20);
    await cue.waitLog(/Answer\*\* \(/, 60);
    const asked = cue.save('asked.txt', cue.claudeRequests('ask').join('\n----\n'));
    assertContains(asked, /^Question: \[Participant\].*how many hives/i);
    const answered = cue.save('answered.txt', await cue.snapshotText(cue.path('cue.png')));
    assertContains(answered, /Counted every spring/, 'the answer should show in full');
});
