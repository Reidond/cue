import {
    assertDeepEq,
    assertEq,
    assertTextContains,
    e2eCase,
    fail,
    fixture,
    makeNotes,
    noteEvents,
    RECORDED_SCRIPT,
    recordCall,
    waitForNote,
} from '../harness/index.ts';

e2eCase(
    "With two languages chosen, a call's notes are translated into the other one: the title, the summary and each line of the transcript, " +
        'names and labels kept, so a rename reaches the translation too.',
    async (cue) => {
        cue.standIns({ FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT, FAKE_CLAUDE_SUMMARY: fixture('summaries', 'speaker-names.md') });
        const backend = await cue.backend();
        const recorded = await recordCall(cue, backend, 'ann@cue.test');
        await backend.call('PUT', '/v1/me/languages', recorded.token, { body: { languages: ['en', 'uk'] } });
        const started = await makeNotes(backend, recorded);
        assertEq(started.steps.at(-1)?.id, 'translate', 'the last step translates the notes');
        const events = await noteEvents(backend, recorded.token, started.id);
        const note = await waitForNote(cue, backend, recorded.token, started.id);
        const lines = events.flatMap((event) => (event.line === null ? [] : [event.line]));
        assertEq(lines.includes('🌐 Translating notes…'), true, JSON.stringify(lines));
        assertEq(lines.includes(`✅ Notes translated into Ukrainian: ${note.transcript.length} lines`), true, JSON.stringify(lines));

        const translation = note.translation ?? fail('the note should have its translation', JSON.stringify(note));
        assertEq(translation.language, 'uk');
        assertEq(translation.name, 'Ukrainian');
        assertEq(translation.title, '(Ukrainian) Reading room plan', 'the title');
        assertTextContains(translation.summary, /^\(Ukrainian\) Participant 1 opened the call/, 'the summary, labels as they were');
        assertEq(translation.transcript.length, note.transcript.length, 'a line for each turn');
        assertDeepEq(
            translation.transcript,
            note.transcript.map((turn) => `(Ukrainian) ${turn.text}`),
            'each turn, in order',
        );
        assertTextContains(cue.claudeRequests('translate-system')[0]!, /^You translate the notes of a call into Ukrainian/);

        // A rename reaches the translation.
        const renamed = await backend.call('PATCH', `/v1/notes/${note.id}`, recorded.token, {
            body: { rename: { from: 'Participant 1', to: 'Petro' } },
        });
        assertTextContains(renamed.body.translation.summary, /^\(Ukrainian\) Petro opened the call/);

        // A summary turned off still gets its title translated, and a speaker who talks for minutes goes in pieces that come back as one line.
        const long = Array.from({ length: 60 }, (_, index) => `Sentence number ${index + 1} about the rooftop hives.`).join(' ');
        cue.standIns({
            FAKE_DEEPGRAM_FILE: JSON.stringify({
                me: ['I will send the report by Friday.'],
                others: [
                    { text: long, speaker: 0 },
                    { text: 'Thank you.', speaker: 1 },
                ],
            }),
        });
        const asked = cue.claudeRequests('translate-input').length;
        const third = await recordCall(cue, backend, 'ann@cue.test');
        const untitled = await waitForNote(cue, backend, third.token, (await makeNotes(backend, third, { summarize: false })).id);
        const pieces = cue.claudeRequests('translate-input').slice(asked);
        assertEq(pieces[0], `Title: ${untitled.title}`, 'the title alone, with no summary');
        assertEq(untitled.translation?.title, `(Ukrainian) ${untitled.title}`);
        const said = untitled.transcript.findIndex((turn) => turn.text === long);
        const translated = untitled.translation?.transcript[said] ?? '';
        assertEq((translated.match(/\(Ukrainian\)/g) ?? []).length >= 2, true, `the long turn went in pieces: ${translated}`);
        assertTextContains(translated, /Sentence number 60 about the rooftop hives\.$/, 'and all of it came back, in order');

        // One language: no translation step.
        await backend.call('PUT', '/v1/me/languages', recorded.token, { body: { languages: ['uk'] } });
        const second = await recordCall(cue, backend, 'ann@cue.test');
        const plain = await makeNotes(backend, second);
        assertEq(
            plain.steps.some((step) => step.id === 'translate'),
            false,
            'nothing to translate into',
        );
        assertEq((await waitForNote(cue, backend, second.token, plain.id)).translation === null, true, 'and no translation');
    },
);
