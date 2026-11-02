import {
    assertEq,
    assertTextContains,
    e2eCase,
    exec,
    makeNotes,
    press,
    RECORDED_SCRIPT,
    recordCall,
    waitForNote,
    windowText,
} from '../harness/index.ts';

/** How many things in the Recycle Bin are called like this (Explorer’s own list). */
async function inRecycleBin(name: string): Promise<number> {
    const ran = await exec('powershell.exe', [
        '-NoProfile',
        '-Command',
        '[Console]::OutputEncoding = [Text.Encoding]::UTF8; (New-Object -ComObject Shell.Application).NameSpace(10).Items() | ForEach-Object { $_.Name }',
    ]);
    return ran.stdout.split('\n').filter((line) => line.includes(name)).length;
}

e2eCase(
    'Cue for Windows: Move to Recycle Bin on a note’s page asks first, then takes the note (and its audio) out of the project’s folder into the Recycle Bin, ' +
        'deletes it from the account with its audio, and leaves the page with none.',
    async (cue) => {
        // A note the account already has, restored at sign-in; its recording is still in storage.
        cue.standIns({ FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT });
        const backend = await cue.backend();
        const recorded = await recordCall(cue, backend, cue.email);
        const started = await makeNotes(backend, recorded);
        const note = await waitForNote(cue, backend, recorded.token, started.id);
        assertEq(backend.objects().length > 0, true, 'the recording should be in storage');

        await cue.launch();
        await cue.waitLog(/☁️ Restored 1 note from your account/, 60);
        const before = await inRecycleBin(note.title);
        cue.control('page Bee talk/notes');
        await cue.waitFor('the note on its page', 60, async () => (await windowText(cue.pid)).split('\n').includes(note.title));
        assertEq(cue.findNotes().length, 1, 'the note is in the project’s folder');

        // The button asks first; Cancel changes nothing.
        await press(cue.pid, 'Move this note to the Recycle Bin');
        await cue.waitFor('the question', 20, async () => /^Move “.*” to the Recycle Bin\?$/m.test(await windowText(cue.pid)));
        await press(cue.pid, 'Cancel');
        await cue.waitFor('the question to go', 20, async () => !/^Move “.*” to the Recycle Bin\?$/m.test(await windowText(cue.pid)));
        assertEq(cue.findNotes().length, 1, 'cancelled: the note stays');
        assertEq((await (await backend.accountOf(cue.email)).notes()).length, 1, 'and so does the account’s');

        // Then it moves.
        await press(cue.pid, 'Move this note to the Recycle Bin');
        await cue.waitFor('the question', 20, async () => /^Move “.*” to the Recycle Bin\?$/m.test(await windowText(cue.pid)));
        await press(cue.pid, 'Move to Recycle Bin');
        await cue.waitFor('the note to leave the folder', 30, () => cue.findNotes().length === 0);
        await cue.waitFor(
            'the account to lose the note',
            30,
            async () => (await (await backend.accountOf(cue.email)).notes()).length === 0,
        );
        assertEq(backend.objects().length, 0, 'its audio is deleted from storage at once');
        assertEq((await inRecycleBin(note.title)) > before, true, 'the note is in the Recycle Bin, where it can be restored from');

        // The page has none left.
        await cue.waitFor('the empty page', 20, async () => /^No Notes$/m.test(await windowText(cue.pid)));
        assertTextContains(await windowText(cue.pid), /^Record$/, 'and the record button to make one');
    },
);
