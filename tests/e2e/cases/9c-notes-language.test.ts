import {
    assertDeepEq,
    assertEq,
    assertTextContains,
    DEEPGRAM,
    e2eCase,
    makeNotes,
    recordCall,
    skip,
    waitForNote,
} from '../harness/index.ts';

/** The call of `recordCall`, heard in Ukrainian: what the live stand-in says, then what the second pass hears in the recording. */
const LIVE = JSON.stringify([
    { text: 'Доброго ранку. Коли буде готовий звіт?', speaker: 0 },
    'Я надішлю звіт у пʼятницю.',
    { text: 'Дякую, Олено. До понеділка.', speaker: 1 },
]);
const RECORDED = JSON.stringify({
    me: ['Я надішлю звіт у пʼятницю.'],
    others: [
        { text: 'Доброго ранку. Коли буде готовий звіт?', speaker: 0 },
        { text: 'Дякую, Олено. До понеділка.', speaker: 1 },
    ],
});

e2eCase(
    'A note is worded in the language its call was held in, which nobody chose: the one heard live, then the one the second pass hears in the ' +
        'whole recording.',
    async (cue) => {
        if (DEEPGRAM !== 'fake') skip("scripts Deepgram's replies through the stand-in");
        cue.standIns({ FAKE_DEEPGRAM_LIVE: LIVE, FAKE_DEEPGRAM_FILE: RECORDED });
        const backend = await cue.backend();

        // Heard live in Ukrainian, notes without the second pass: the live transcript, worded in Ukrainian from the start.
        const live = await recordCall(cue, backend, 'ann@cue.test', { live: true });
        const plain = await waitForNote(cue, backend, live.token, (await makeNotes(backend, live, { sides: [], summarize: false })).id);
        assertEq(plain.language, 'uk', 'the language the call was heard in live');
        assertEq(plain.transcriptHeading, 'Транскрипт');
        assertDeepEq(
            plain.participants,
            ['Andrii', 'Учасник 1', 'Учасник 2'],
            'the voices live recognition told apart, named in Ukrainian',
        );

        // The live call heard nothing (it ended at once): the second pass hears the recording, and the note follows it.
        const recorded = await recordCall(cue, backend, 'bob@cue.test');
        const note = await waitForNote(cue, backend, recorded.token, (await makeNotes(backend, recorded)).id);
        assertEq(note.language, 'uk', 'heard in the recording');
        assertEq(note.transcriptHeading, 'Транскрипт');
        assertDeepEq(note.participants, ['Andrii', 'Учасник 1', 'Учасник 2'], 'two voices, numbered in Ukrainian');
        for (const request of cue.serviceRequests('deepgram-file'))
            assertEq(request.query['language'], 'multi', 'every language listened for');
        assertTextContains(cue.claudeRequests('summary-system').at(-1)!, /Ukrainian/, 'the summary is asked for in it');
    },
);
