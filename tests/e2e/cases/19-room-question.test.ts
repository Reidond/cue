import { assertContains, dialogue, e2eCase, fixture } from '../harness/index.ts';

e2eCase('With questions from the room on, the judge hears the microphone as the room, and a question there is answered.', async (cue) => {
    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.defaults('speakerName', 'Andrii Test');
    await cue.defaults('autoAnswer', true);
    await cue.defaults('micQuestions', true);
    const call = await dialogue(fixture('dialogues', 'room-question.txt'), cue.path('call'));
    await cue.launch({ CUE_REHEARSE_PARTICIPANT: call.wav('call'), CUE_REHEARSE_ME: call.wav('me'), FAKE_DEEPGRAM_LIVE: call.live() });
    await cue.waitLog(/❓ \*\*Question:\*\* How many hives/, 120);

    const judged = cue.save('judged.txt', cue.claudeRequests('judge').join('\n----\n'));
    assertContains(judged, /^\[Room\] How many hives did you study\?/, "the room's question shouldn't be labelled as the speaker's");
    const prompt = cue.save('judge-system.txt', cue.claudeRequests('judge-system').join(''));
    assertContains(prompt, /shows up as \[Room\]/, "the judge's prompt should say what [Room] is");
});
