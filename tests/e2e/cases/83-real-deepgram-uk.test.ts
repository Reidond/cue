import { assertContains, assertNotContains, dialogue, e2eCase, fixture, needRealDeepgram } from '../harness/index.ts';

e2eCase(
    "With the real Deepgram behind the backend, a Ukrainian call is transcribed live, with the project's names and terms " +
        'spelled as it has them.',
    async (cue) => {
        await needRealDeepgram();

        await cue.defaults('speakerName', 'Андрій Тест');
        await cue.defaults('autoAnswer', false);
        await cue.project('Звіт', {
            language: 'uk',
            occasion: 'Щотижнева зустріч щодо звіту',
            namesAndTerms: 'Олена Мулеса, узгодженість даних',
        });
        const call = await dialogue(fixture('dialogues', 'deadline-uk.txt'), cue.path('call'));
        await cue.launch({
            CUE_PROJECT: 'Звіт',
            CUE_REHEARSE_RECORD: '1',
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            CUE_REHEARSE_ME: call.wav('me'),
        });
        await cue.waitLog(/Transcript saved/, 240);

        const log = cue.sessionLog();
        assertNotContains(log, /Speech recognition unavailable/);
        assertContains(log, /\*\*\[Participant\]\*\* \S/, 'the call side, heard live');
        assertContains(log, /\*\*\[Андрій Тест\]\*\* \S/, 'and your side');
        assertContains(log, /узгодженост[іи] даних/, 'the names and terms, as the project spells them');
        assertContains(log, /залишилося перевірити таблиці/, 'your side, in Ukrainian');
    },
);
