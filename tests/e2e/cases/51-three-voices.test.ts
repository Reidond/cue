import {
    assertContains, assertEq, assertFile, assertNotContains, CLAUDE, countLines, dialogue, e2eCase, fixture, labelsOf,
    matches, needWhisper, print, turnSpeakers,
} from '../harness/index.ts';

e2eCase('After the second pass, Cue tells the voices on the call side apart: a call with three people on it comes '
    + 'out with three participants plus you, every line under the label of the voice that said it, consecutive lines '
    + 'of one voice as one turn; the participants and the summary prompt list them.', async (cue) => {
    needWhisper();

    await cue.defaults('speakerName', 'Andrii Test');
    await cue.defaults('autoAnswer', false);
    await cue.project('Library', { language: 'en' });
    const call = await dialogue(fixture('dialogues', 'three-voices.txt'), cue.path('call'));
    await cue.launch({
        CUE_PROJECT: 'Library', CUE_REHEARSE_RECORD: '1',
        CUE_REHEARSE_PARTICIPANT: call.wav('call'), CUE_REHEARSE_ME: call.wav('me'),
    });
    await cue.waitLog(/Notes ready/, 300);

    // The steps, in order: speakers are found after the second pass and before the summary.
    const log = cue.sessionLog();
    const steps = matches(log, /Improving transcript…|Transcript improved|Finding speakers…|Speakers: [0-9]+|Writing summary…|Notes ready/).join(',');
    assertEq(steps, 'Improving transcript…,Transcript improved,Finding speakers…,Speakers: 3,Writing summary…,Notes ready',
        `the note should go through its steps in order: ${steps}`);

    const notes = cue.readyNotes();
    assertFile(notes);
    assertContains(notes, /^participants: Andrii Test, Participant 1, Participant 2, Participant 3$/);
    assertNotContains(notes, /· Participant\*\*$/, "every call-side turn should have its speaker's number");

    // Each line of the dialogue is under its voice's label: one label per voice, a different one for each.
    const speakers = turnSpeakers(notes, call.timeline);
    const table = cue.save('speakers.tsv', speakers);
    print(speakers);
    assertNotContains(table, /\?$/, 'every line should start a turn of its own');
    assertEq(labelsOf(speakers, 'Samantha'), 'Andrii Test', 'your lines should be yours');
    assertEq(labelsOf(speakers, 'Daniel'), 'Participant 1', 'Daniel speaks first, so he is Participant 1 on all his lines');
    assertEq(labelsOf(speakers, 'Karen'), 'Participant 2', 'Karen should be Participant 2 on all her lines');
    assertEq(labelsOf(speakers, 'Fred'), 'Participant 3', 'Fred should be Participant 3 on all his lines');
    assertEq(countLines(notes, /^\*\*[0-9]{2}:[0-9]{2}:[0-9]{2} · /), 11, 'each line of the call is its own turn');

    // The summary is written from the labelled transcript, and asked for names where the call makes them clear.
    if (CLAUDE === 'fake') {
        const input = cue.save('summary-input.txt', cue.claudeRequests('summary-input').join(''));
        assertContains(input, /\[Participant 2\] .*visitor survey/);
        assertContains(input, /\[Participant 3\] .*budget/);
        const system = cue.save('summary-system.txt', cue.claudeRequests('summary-system').join(''));
        assertContains(system,
            /\[Andrii Test\] is the person who recorded the call; \[Participant 1\], \[Participant 2\] and \[Participant 3\] are the other people on the call, told apart by their voices/);
        assertContains(system, /<!-- speaker: Participant 1 = Olena Mulesa -->/);
    }
});
