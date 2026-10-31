import {
    assertContains,
    assertEq,
    assertNotContains,
    countLines,
    dialogue,
    e2eCase,
    fixture,
    linesOf,
    matches,
    needWhisper,
    readText,
} from '../harness/index.ts';

e2eCase(
    "When speakers can't be told apart (here the speaker models can't be fetched: a file is where their folder " +
        'should be), the note keeps its transcript as it was, under the plain participant label; its page and the ' +
        'session log say what went wrong, and the summary is written all the same.',
    async (cue) => {
        needWhisper();

        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        await cue.project('Library', { language: 'en' });
        const blocked = cue.save('blocked', 'not a folder\n');
        const call = await dialogue(fixture('dialogues', 'two-voices.txt'), cue.path('call'));
        await cue.launch({
            CUE_PROJECT: 'Library',
            CUE_REHEARSE_RECORD: '1',
            CUE_SPEAKER_MODELS: blocked,
            CUE_SNAPSHOT: cue.path('cue.png'),
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            CUE_REHEARSE_ME: call.wav('me'),
        });
        await cue.waitLog(/Notes ready/, 300);

        const log = cue.sessionLog();
        const steps = matches(log, /Transcript improved|Finding speakers…|Couldn't tell speakers apart|Writing summary…|Notes ready/).join(
            ',',
        );
        assertEq(
            steps,
            "Transcript improved,Finding speakers…,Couldn't tell speakers apart,Writing summary…,Notes ready",
            `the summary should still be written after the failed step: ${steps}`,
        );
        assertContains(log, /⚠︎ Couldn't tell speakers apart: .+ — the transcript is kept as it was$/);
        assertNotContains(log, /✅ Speakers:/);

        // The improved transcript, as the second pass left it: one label for everyone on the call.
        const notes = cue.readyNotes();
        assertContains(notes, /^participants: Andrii Test, Participant$/);
        assertEq(countLines(notes, /^\*\*[0-9:]+ · Participant\*\*$/), 2, "the call side's lines keep the plain label");
        assertNotContains(notes, /Participant [0-9]/);
        assertContains(notes, /survey summary before then/);
        assertContains(notes, /^## Summary/);

        // The note's page keeps its steps, with what went wrong.
        await cue.dashboardPage('Library/notes', /kept as it was/);
        const page = cue.page;
        assertContains(page, /Improving transcript$/);
        assertContains(page, /Finding speakers$/);
        // The reason wraps wherever the page's width puts it (the error names the sandbox's folder): read it as one paragraph.
        const reason = cue.save('reason.txt', linesOf(readText(page) ?? '').join(' '));
        assertContains(reason, /already exists\. The transcript is kept as it was\./, 'the reason should read as one sentence');
        assertContains(page, /Writing summary$/);
        assertContains(page, /^Summary$/);
    },
);
