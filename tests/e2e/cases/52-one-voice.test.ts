import {
    assertContains,
    assertEq,
    assertNotContains,
    countLines,
    dialogue,
    e2eCase,
    fixture,
    labelsOf,
    needWhisper,
    print,
    turnSpeakers,
} from '../harness/index.ts';

e2eCase(
    'A call with one person on the call side keeps the plain participant label: no numbers, and the participants ' +
        'are you and «Participant», as before speakers were told apart.',
    async (cue) => {
        needWhisper();

        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        await cue.project('Interviews', { language: 'en' });
        const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
        await cue.launch({
            CUE_PROJECT: 'Interviews',
            CUE_REHEARSE_RECORD: '1',
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            FAKE_DEEPGRAM_LIVE: call.live(),
            CUE_REHEARSE_ME: call.wav('me'),
        });
        await cue.waitLog(/Notes ready/, 300);
        assertContains(cue.sessionLog(), /👥 Finding speakers…$/);
        assertContains(cue.sessionLog(), /✅ Speakers: 1 /);

        const notes = cue.readyNotes();
        assertContains(notes, /^participants: Andrii Test, Participant$/);
        assertEq(countLines(notes, /^\*\*[0-9:]+ · Participant\*\*$/), 2, "both of the participant's lines keep the plain label");
        assertNotContains(notes, /Participant [0-9]/);
        const speakers = turnSpeakers(notes, call.timeline);
        cue.save('speakers.tsv', speakers);
        print(speakers);
        assertEq(labelsOf(speakers, 'Daniel'), 'Participant');

        // The summary is told there is one other label, which may stand for several people.
        const system = cue.save('summary-system.txt', cue.claudeRequests('summary-system').join(''));
        assertContains(system, /\[Andrii Test\] is the person who recorded the call; the other label is everyone else/);
    },
);
