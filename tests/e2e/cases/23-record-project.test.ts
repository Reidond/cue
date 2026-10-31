import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertContains, assertEq, assertFile, dialogue, e2eCase, fail, fixture, listDir, needWhisper } from '../harness/index.ts';

e2eCase("A recording goes into the active project's Notes/ and says which project it belongs to.", async (cue) => {
    needWhisper();

    // Projects made by hand: a folder with project.json, and a bare folder.
    await cue.project('Interviews', { language: 'en' });
    await mkdir(join(cue.projectPath('Other project'), 'Notes'), { recursive: true });
    const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
    await cue.launch({
        CUE_PROJECT: 'Interviews',
        CUE_REHEARSE_RECORD: '1',
        CUE_REHEARSE_PARTICIPANT: call.wav('call'),
        FAKE_DEEPGRAM_LIVE: call.live(),
        CUE_REHEARSE_ME: call.wav('me'),
    });
    await cue.waitLog(/Project: Interviews/, 10);
    await cue.waitLog(/Transcript saved: .*\/Documents\/Cue\/Interviews\/Notes\//, 120);
    await cue.waitLog(/Notes ready/, 180);

    const notes = cue.readyNotes();
    assertFile(notes);
    if (!/\/Documents\/Cue\/Interviews\/Notes\/.*\.md$/.test(notes)) fail(`notes should be in Interviews/Notes: ${notes}`);
    assertContains(notes, /^project: "Interviews"$/);
    assertContains(notes, /^## Transcript/);
    assertEq(cue.findNotes().length, 1, 'expected exactly one notes file');
    assertEq(listDir(join(cue.projectPath('Other project'), 'Notes')).length, 0, 'other projects get nothing');
});
