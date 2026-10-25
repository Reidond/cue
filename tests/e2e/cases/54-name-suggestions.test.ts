import {
    assertContains, assertEq, assertNotContains, CLAUDE, countLines, dialogue, e2eCase, fixture, labelsOf, lines,
    needWhisper, skip, summaryOf, turnSpeakers,
} from '../harness/index.ts';

e2eCase('The summary may say who a participant is (they are thanked by name): its suggestion lines are kept out of '
    + "the notes and show on the note's page as a chip, «Participant 2 → Olena Mulesa?», whose Apply renames them "
    + "throughout the note. Suggestions for labels that aren't the call's are ignored.", async (cue) => {
    needWhisper();
    if (CLAUDE !== 'fake') skip("needs the fake claude's summary");

    await cue.defaults('speakerName', 'Andrii Test');
    await cue.defaults('autoAnswer', false);
    await cue.project('Library', { language: 'en' });
    const call = await dialogue(fixture('dialogues', 'two-voices.txt'), cue.path('call'));
    await cue.launch({
        CUE_PROJECT: 'Library', CUE_REHEARSE_RECORD: '1', FAKE_CLAUDE_SUMMARY: fixture('summaries', 'speaker-names.md'),
        CUE_SNAPSHOT: cue.path('cue.png'),
        CUE_REHEARSE_PARTICIPANT: call.wav('call'), CUE_REHEARSE_ME: call.wav('me'),
    });
    await cue.waitLog(/Notes ready/, 300);
    await cue.waitLog(/✅ Speakers: 2 /, 1);
    assertContains(cue.sessionLog(), /💡 Suggested name: Participant 2 → Olena Mulesa$/);
    assertEq(cue.logCount(/💡 Suggested name/), 1, "only the call's own labels get suggestions");

    // The suggestion is in the front matter, not in the notes.
    let notes = cue.readyNotes();
    assertContains(notes, /^suggestions: \{"Participant 2": "Olena Mulesa"\}$/);
    assertNotContains(notes, /<!-- speaker/, 'the suggestion lines should be kept out of the notes');
    assertContains(notes, /^participants: Andrii Test, Participant 1, Participant 2$/);

    // Its chip, with Apply, on the note's page; the front matter row doesn't show it.
    const page = cue.page;
    await cue.dashboardPage('Library/notes', /Participant 2 → Olena Mulesa\?/);
    assertContains(page, /Apply/);
    assertEq(countLines(page, /Olena Mulesa/), 1,
        `only the chip should name Olena Mulesa: ${lines(page).filter((line) => line.includes('Olena Mulesa')).join('\n')}`);

    cue.control('apply Participant 2');
    await cue.waitLog(/✏️ Renamed “Participant 2” to “Olena Mulesa”/, 10);
    notes = cue.findNotes()[0] ?? '';
    assertContains(notes, /^participants: Andrii Test, Participant 1, Olena Mulesa$/);
    assertNotContains(notes, /^suggestions:/, 'an applied suggestion goes');
    assertNotContains(notes, /Participant 2/, 'Olena Mulesa should replace the label everywhere');
    const summary = cue.save('summary.md', summaryOf(notes));
    assertContains(summary, /and Olena Mulesa summed up the visitor survey\.$/);
    assertContains(summary, /^- \[ \] Olena Mulesa: send the survey summary/);
    const speakers = turnSpeakers(notes, call.timeline);
    cue.save('speakers.tsv', speakers);
    assertEq(labelsOf(speakers, 'Karen'), 'Olena Mulesa');

    // The chip is gone and the note names her.
    const applied = async (): Promise<boolean> => (await cue.dashboardShows(/Olena Mulesa: send the survey summary/))
        && countLines(page, /→ Olena/) === 0;
    await cue.waitFor('the chip to go', 20, applied);
    assertNotContains(page, /Apply/);
});
