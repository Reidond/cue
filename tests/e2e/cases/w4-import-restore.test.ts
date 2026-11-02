import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
    assertContains,
    assertEq,
    assertFile,
    assertNotContains,
    assertTextContains,
    e2eCase,
    fixture,
    makeNotes,
    RECORDED_SCRIPT,
    recordCall,
    sleep,
    waitForNote,
    windowText,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: after signing in, a note this PC had before it had an account goes up to it once, and a note the account has that this PC lacks is ' +
        'written to the project’s folder; the dashboard lists both, and a second launch changes nothing.',
    async (cue) => {
        await cue.defaults('speakerName', 'Andrii');
        // The account’s note (made as another PC would have), in the project “Bee talk”.
        cue.standIns({ FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT });
        const backend = await cue.backend();
        const recorded = await recordCall(cue, backend, cue.email);
        const started = await makeNotes(backend, recorded);
        await waitForNote(cue, backend, recorded.token, started.id);

        // This PC’s: a project with a note, as an earlier Cue left them (no `note:` in it).
        const rooftop = await cue.project('Rooftop', { language: 'en' });
        await mkdir(join(rooftop, 'Notes'), { recursive: true });
        const old = join(rooftop, 'Notes', '2026-10-24 11.05 – Weekly sync about the report.md');
        await copyFile(fixture('notes', 'sample.md'), old);

        await cue.launch();
        await cue.waitLog(/📦 Imported 1 project from this PC \(0 files\)/, 60);
        await cue.waitLog(/📦 Imported 1 note from this PC/, 60);
        await cue.waitLog(/☁️ Restored 1 note from your account/, 60);

        // The old note is the account’s now, with its summary and transcript, and its file says so.
        const account = await backend.accountOf(cue.email);
        const stored = await account.notes();
        assertEq(stored.length, 2, 'the account has both notes');
        const imported = stored.find((note) => note.title === 'Weekly sync about the report');
        assertEq(imported?.status, 'ready');
        assertEq(imported?.summary.includes('send the beekeeping report by Friday'), true, 'its summary');
        assertEq(imported?.transcript.length, 2, 'its transcript');
        assertContains(old, new RegExp(`^note: ${imported?.id}$`));
        assertContains(old, /^## Transcript$/, 'the file is as it was');

        // The account’s is a file in its project now.
        const restored = stored.find((note) => note.id === started.id);
        const files = cue.findNotes().filter((file) => file !== old);
        assertEq(files.length, 1, 'the restored note is one file');
        const file = files[0] ?? '';
        assertFile(file);
        assertContains(file, new RegExp(`^note: ${restored?.id}$`));
        assertContains(file, /^## Transcript$/);
        assertContains(file, /^\*\*00:00:05 · Andrii\*\*$/);
        assertEq(file.includes(`${join(cue.documents, 'Cue', 'Bee talk', 'Notes')}`), true, 'in its own project’s Notes folder');

        // Home lists both.
        cue.control('page home');
        await cue.waitFor('both on Home', 30, async () => {
            const text = await windowText(cue.pid);
            return /^Weekly sync about the report$/m.test(text) && /^E2E rehearsal notes$/m.test(text);
        });
        assertTextContains(await windowText(cue.pid), /^Recent Notes$/);

        // A second launch changes nothing: nothing imported again, nothing restored again.
        await cue.stop();
        await sleep(1); // session logs are named by the second
        await cue.launch();
        await cue.waitLog(/📁 Project: /, 60);
        await sleep(2);
        const log = cue.sessionLog();
        assertNotContains(log, /Imported/);
        assertNotContains(log, /Restored/);
        assertEq(cue.findNotes().length, 2, 'still two notes');
        assertEq((await account.notes()).length, 2, 'the account still has two');
    },
);
