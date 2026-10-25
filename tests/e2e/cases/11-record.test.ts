import { basename } from 'node:path';
import {
    assertContains, assertEq, assertFile, assertNotContains, CLAUDE, dialogue, e2eCase, fail, fixture, needWhisper,
} from '../harness/index.ts';

e2eCase('A two-sided rehearsal is recorded into notes with both sides, a summary and a title.', async (cue) => {
    needWhisper();

    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.defaults('speakerName', 'Andrii Test');
    await cue.defaults('autoAnswer', false);
    const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
    await cue.launch({
        CUE_REHEARSE_RECORD: '1', CUE_REHEARSE_PARTICIPANT: call.wav('call'), CUE_REHEARSE_ME: call.wav('me'),
    });
    await cue.waitLog(/Transcript saved/, 120);
    await cue.waitLog(/Notes ready/, 180);

    const notes = cue.readyNotes();
    assertFile(notes);
    assertEq(cue.findNotes().length, 1, 'expected exactly one notes file');
    assertContains(notes, /^## Transcript/);
    assertContains(notes, /^\*\*00:00:[0-9]{2} · Participant\*\*/);
    assertContains(notes, /^\*\*00:00:[0-9]{2} · Andrii Test\*\*/);
    assertContains(notes, /bee ?keeping report/);
    assertContains(notes, /by Friday/);
    assertContains(notes, /^## Summary/);
    assertNotContains(notes, /^_…_$/, 'the summary placeholder should be replaced');
    if (CLAUDE === 'fake') {
        assertContains(notes, /^title: "E2E rehearsal notes"/);
        if (!basename(notes).endsWith(' – E2E rehearsal notes.md')) {
            fail(`the file should be renamed after the summary's title: ${basename(notes)}`);
        }
        const system = cue.save('summary-system.txt', cue.claudeRequests('summary-system').join(''));
        assertContains(system, /\[Andrii Test\] is the person who recorded the call/);
        const input = cue.save('summary-input.txt', cue.claudeRequests('summary-input').join(''));
        assertContains(input, /\[Participant\].*report/);
    }
});
