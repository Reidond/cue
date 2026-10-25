import {
    assertContains, assertNotContains, dialogue, e2eCase, fixture, needRealClaude, needWhisper, print, summaryOf,
} from '../harness/index.ts';

e2eCase("With the real Claude, the Ukrainian test call's notes say «до п'ятниці» and make no remarks about the "
    + 'transcript or speech recognition.', async (cue) => {
    needRealClaude();
    needWhisper();

    await cue.defaults('speakerName', 'Андрій Тест');
    await cue.defaults('autoAnswer', false);
    await cue.project('Звіт', {
        language: 'uk', occasion: 'Щотижнева зустріч щодо звіту', namesAndTerms: 'Олена Мулеса, узгодженість даних',
    });
    const call = await dialogue(fixture('dialogues', 'deadline-uk.txt'), cue.path('call'));
    await cue.launch({
        CUE_PROJECT: 'Звіт', CUE_REHEARSE_RECORD: '1',
        CUE_REHEARSE_PARTICIPANT: call.wav('call'), CUE_REHEARSE_ME: call.wav('me'),
    });
    await cue.waitLog(/Notes ready/, 300);
    assertNotContains(cue.sessionLog(), /Summary failed/);

    const text = summaryOf(cue.readyNotes());
    const summary = cue.save('summary.md', text);
    print(text);
    assertContains(summary, /^## /);
    assertContains(summary, /п['’ʼ]ятниц/);
    assertNotContains(summary, /транскрипт|розпізна|розшифров|transcript|recogni|дотатниц/,
        "the summary shouldn't comment on the transcript");
    assertNotContains(cue.sessionLog(), /🧽 Dropped/,
        "Claude itself should keep to the rule; the safety net shouldn't have had to step in");
});
