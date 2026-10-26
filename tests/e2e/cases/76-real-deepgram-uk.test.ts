import { assertContains, assertNotContains, dialogue, e2eCase, fixture, needRealDeepgram } from '../harness/index.ts';

e2eCase('With the real Deepgram, a Ukrainian call is transcribed live and again after it, with the names and terms '
    + 'spelled as the project has them.', async (cue) => {
    await needRealDeepgram();

    await cue.defaults('speakerName', 'Андрій Тест');
    await cue.defaults('autoAnswer', false);
    await cue.defaults('speechProvider', 'deepgram');
    await cue.apiKey('deepgram');
    await cue.project('Звіт', {
        language: 'uk', occasion: 'Щотижнева зустріч щодо звіту', namesAndTerms: 'Олена Мулеса, узгодженість даних',
    });
    const call = await dialogue(fixture('dialogues', 'deadline-uk.txt'), cue.path('call'));
    await cue.launch({
        CUE_PROJECT: 'Звіт', CUE_REHEARSE_RECORD: '1', CUE_REHEARSE_PARTICIPANT: call.wav('call'), CUE_REHEARSE_ME: call.wav('me'),
    });
    await cue.waitLog(/✅ Transcript improved/, 240);
    await cue.waitLog(/Notes ready/, 240);

    assertNotContains(cue.sessionLog(), /Speech recognition unavailable|Couldn't improve the transcript/);
    const notes = cue.readyNotes();
    assertContains(notes, /^\*\*00:00:[0-9]{2} · Учасник\*\*/);
    assertContains(notes, /^\*\*00:00:[0-9]{2} · Андрій Тест\*\*/);
    assertContains(notes, /узгодженост[іи] даних/, 'the names and terms, as the project spells them');
    assertContains(notes, /залишилося перевірити таблиці/, 'your side, in Ukrainian');
    // Deepgram hears «до п'ятниці» from this voice as «до татниці», live and in the second pass alike (as
    // Whisper does live): the summary is what sets it right (see 45).

});
