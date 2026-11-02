import { accountProject, assertTextContains, assertTextNotContains, bursts, e2eCase, fixture, windowText } from '../harness/index.ts';

e2eCase('Cue for Windows: an older answer opened to read stays open as new questions arrive under a New Question button.', async (cue) => {
    await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
    const call = await bursts(cue.path('call.wav'), 18, [
        [1, 3],
        [7, 9],
        [14, 16],
    ]);
    await cue.launch({
        CUE_PROJECT: 'Bees',
        CUE_REHEARSE_PARTICIPANT: call,
        FAKE_DEEPGRAM_LIVE: JSON.stringify(['How many hives did you study?', 'Which rooftops did you use?', 'When did the bees swarm?']),
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
    await cue.waitFor('the New Question button', 20, async () => /New Question/.test(await windowText(cue.pid)));
    const reading = await windowText(cue.pid);
    cue.save('reading.txt', reading);
    assertTextContains(reading, /Point about hives/, 'the answer being read should stay open');
    assertTextNotContains(reading, /Point about swarms/, 'the new answer should not take its place');
    assertTextContains(reading, /^1 New Question$/, 'the new question should wait under a button');

    cue.control('newest');
    await cue.waitFor('the newest answer to show', 20, async () => /Point about swarms/.test(await windowText(cue.pid)));
    const newest = await windowText(cue.pid);
    cue.save('newest.txt', newest);
    assertTextNotContains(newest, /New Question/, 'the button should go once the newest is shown');
});
