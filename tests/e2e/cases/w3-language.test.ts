import {
    accountProject,
    assertEq,
    assertTextContains,
    assertTextNotContains,
    bursts,
    e2eCase,
    fixture,
    windowText,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: nobody says what language a call is in; Cue hears it, says so in the session log, and sets the answer on the overlay with ' +
        "that language's labels.",
    async (cue) => {
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        const call = await bursts(cue.path('call.wav'), 5, [[1, 3.5]]);
        await cue.launch({
            CUE_PROJECT: 'Bees',
            CUE_REHEARSE_PARTICIPANT: call,
            // The Deepgram stand-in hears Cyrillic as Ukrainian.
            FAKE_DEEPGRAM_LIVE: JSON.stringify(['Дякую за доповідь. Скільки вуликів ви досліджували?']),
            FAKE_CLAUDE_ANSWER: 'Ми дослідили 48 вуликів на шести дахах.\nЦифри: 48 вуликів, 6 дахів\nДжерело: talk.md',
        });
        await cue.waitLog(/📞 Live call started/, 60);
        await cue.waitLog(/🌐 Language heard: Ukrainian/, 90);
        await cue.waitLog(/❓ \*\*Question:\*\* Скільки вуликів ви досліджували\?/, 60);
        await cue.waitLog(/Answer\*\* \(/, 60);
        assertEq(cue.logCount(/🌐 Language heard/), 1, 'once: the call stays in it');

        // The answer's numbers and source lines are Ukrainian's, set as details without their labels.
        let text = '';
        await cue.waitFor('the answer on the overlay', 30, async () => {
            text = await windowText(cue.pid);
            return /^Ми дослідили 48 вуликів на шести дахах\.$/m.test(text);
        });
        cue.save('overlay.txt', text);
        assertTextContains(text, /^48 вуликів, 6 дахів$/m, 'the numbers, under their label');
        assertTextContains(text, /^talk\.md$/m, 'the source, under its label');
        assertTextNotContains(text, /^(Цифри|Джерело):/m, "the labels are read in the call's language");
    },
);
