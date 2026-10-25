import { assertContains, assertNotContains, CLAUDE, dialogue, e2eCase, fixture, needWhisper, skip } from '../harness/index.ts';

e2eCase('An older answer opened to read stays open as new questions arrive under a New Question button.', async (cue) => {
    needWhisper();
    if (CLAUDE !== 'fake') skip('tells the answers apart by the stand-in claude’s replies');

    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.defaults('autoAnswer', true);
    const call = await dialogue(fixture('dialogues', 'three-questions.txt'), cue.path('call'));
    await cue.launch({
        CUE_REHEARSE_PARTICIPANT: call.wav('call'),
        CUE_SNAPSHOT: cue.path('cue.png'),
        FAKE_CLAUDE_ANSWERS: JSON.stringify({
            hives: 'We studied 48 hives.\n- Point about hives\nSource: talk.md',
            rooftops: 'We used six rooftops.\n- Point about roofs\nSource: talk.md',
            swarm: 'They swarmed in May.\n- Point about swarms\nSource: talk.md',
        }),
    });
    await cue.waitLog(/Question:.*rooftops/, 90);
    await cue.waitFor('the second answer', 30, () => cue.logCount(/Answer\*\* \(/) >= 2);

    // The user opens the first question again to read it; the third one comes in meanwhile.
    cue.control('show hives');
    await cue.waitLog(/Question:.*swarm/, 60);
    await cue.waitFor('the third answer', 30, () => cue.logCount(/Answer\*\* \(/) >= 3);
    const reading = cue.save('reading.txt', await cue.snapshotText(cue.path('cue.png')));
    assertContains(reading, /Point about hives/, 'the answer being read should stay open');
    assertNotContains(reading, /Point about swarms/, 'the new answer should not take its place');
    // The button floats over the top row, so Vision can read the two as one line.
    assertContains(reading, /New Question/, 'the new question should wait under a button');

    cue.control('newest');
    await cue.waitFor('the newest answer to show', 20, async () =>
        /Point about swarms/.test(await cue.snapshotText(cue.path('cue.png'))));
    const newest = cue.save('newest.txt', await cue.snapshotText(cue.path('cue.png')));
    assertNotContains(newest, /New Question/, 'the button should go once the newest is shown');
});
