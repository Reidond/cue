import { assertContains, assertNotContains, CLAUDE, dialogue, e2eCase, fixture, needWhisper, skip } from '../harness/index.ts';

e2eCase('The answer in view stays while you read it aloud: a question asked meanwhile waits under a New Question '
    + 'button, and its answer comes into view once you pause.', async (cue) => {
    needWhisper();
    if (CLAUDE !== 'fake') skip('tells the answers apart by the stand-in claude’s replies');

    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.defaults('autoAnswer', true);
    const call = await dialogue(fixture('dialogues', 'reading-aloud.txt'), cue.path('call'));
    await cue.launch({
        CUE_REHEARSE_PARTICIPANT: call.wav('call'), CUE_REHEARSE_ME: call.wav('me'),
        CUE_SNAPSHOT: cue.path('cue.png'),
        FAKE_CLAUDE_ANSWERS: JSON.stringify({
            hives: 'We studied 48 hives.\n- Point about hives\nSource: talk.md',
            rooftops: 'We used six rooftops.\n- Point about roofs\nSource: talk.md',
        }),
    });
    await cue.waitLog(/Question:.*hives/, 90);

    // You're reading the first answer when the second question comes: it waits.
    await cue.waitLog(/📖 Waits while you read the answer in view: .*rooftops/, 60);
    const reading = cue.save('reading.txt', await cue.snapshotText(cue.path('cue.png')));
    assertContains(reading, /Point about hives/, 'the answer being read aloud should stay in view');
    assertNotContains(reading, /Point about roofs/, 'the new answer should not take its place');
    assertContains(reading, /New Question/, 'the new question should wait under a button');

    // You pause: the waiting answer comes into view by itself.
    await cue.waitLog(/📖 Shown now that you've paused: .*rooftops/, 30);
    await cue.waitFor('the second answer to show', 20, async () =>
        /Point about roofs/.test(await cue.snapshotText(cue.path('cue.png'))));
});
