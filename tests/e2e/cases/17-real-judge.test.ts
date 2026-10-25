import { assertEq, dialogue, e2eCase, fail, fixture, matches, needRealClaude, needWhisper, print } from '../harness/index.ts';

e2eCase('With the real Claude, the judge passes over a Ukrainian talk and its rhetorical question, and finds both '
    + 'questions a participant asks in one go.', async (cue) => {
    needRealClaude();
    needWhisper();

    await cue.defaults('speakerName', 'Андрій Тест');
    await cue.defaults('autoAnswer', true);
    await cue.project('Семінар', { language: 'uk', occasion: 'Фаховий семінар про безпеку туристичних подорожей' });
    const call = await dialogue(fixture('dialogues', 'seminar-uk.txt'), cue.path('call'));
    await cue.launch({ CUE_PROJECT: 'Семінар', CUE_REHEARSE_PARTICIPANT: call.wav('call') });
    await cue.waitLog(/Question judge ready/, 60);
    await cue.waitLog(/❓ \*\*Question:\*\* .*област/i, 180);
    await cue.waitFor('the answers', 60, () => cue.logCount(/Answer\*\* \(/) >= 2);

    const asked = matches(cue.sessionLog(), /❓ \*\*Question:\*\* .*/);
    print(asked.join('\n'));
    assertEq(asked.length, 2, 'only the two questions should be asked');
    if (!asked.some((line) => /респондент/i.test(line))) fail('the question about respondents should be asked', asked.join('\n'));
    if (asked.some((line) => /кому/i.test(line))) fail("the talk's rhetorical question shouldn't be", asked.join('\n'));
});
