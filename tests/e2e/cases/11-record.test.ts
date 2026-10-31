import { basename } from 'node:path';
import { assertContains, assertEq, assertFile, assertNotContains, dialogue, e2eCase, fail, fixture } from '../harness/index.ts';

e2eCase('A two-sided rehearsal is recorded into notes with both sides, a summary and a title.', async (cue) => {
    await cue.defaults('materials', [fixture('materials', 'talk.md')]);
    await cue.defaults('language', 'en');
    await cue.defaults('speakerName', 'Andrii Test');
    await cue.defaults('autoAnswer', false);
    const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
    await cue.launch({
        CUE_REHEARSE_RECORD: '1',
        CUE_REHEARSE_PARTICIPANT: call.wav('call'),
        FAKE_DEEPGRAM_LIVE: call.live(),
        FAKE_DEEPGRAM_FILE: call.file(),
        CUE_REHEARSE_ME: call.wav('me'),
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
    assertContains(notes, /^title: "E2E rehearsal notes"/);
    if (!basename(notes).endsWith(' – E2E rehearsal notes.md')) {
        fail(`the file should be renamed after the summary's title: ${basename(notes)}`);
    }
    const system = cue.save('summary-system.txt', cue.claudeRequests('summary-system').join(''));
    assertContains(system, /\[Andrii Test\] is the person who recorded the call/);
    const input = cue.save('summary-input.txt', cue.claudeRequests('summary-input').join(''));
    assertContains(input, /\[Participant\].*report/);

    // The notes are the account's: the backend has them, with the same title and both sides of the transcript.
    const account = await (await cue.backend()).accountOf(cue.email);
    const stored = await account.notes();
    assertEq(stored.length, 1, 'the account should have the one note');
    assertEq(stored[0]?.title, 'E2E rehearsal notes');
    assertEq(stored[0]?.status, 'ready');
    assertEq(
        stored[0]?.transcript.some((turn) => turn.channel === 'me') && stored[0]?.transcript.some((turn) => turn.channel === 'others'),
        true,
    );
});
