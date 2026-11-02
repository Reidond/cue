import {
    assertContains,
    assertDeepEq,
    assertEq,
    assertNotContains,
    assertTextContains,
    assertTextNotContains,
    e2eCase,
    fixture,
    makeNotes,
    press,
    RECORDED_SCRIPT,
    recordCall,
    summaryOf,
    waitForNote,
    windowText,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: a note’s page offers the names its summary suggested — Apply renames the person throughout the note, ✕ drops the suggestion — and a ' +
        'click on a speaker’s name renames them in a dialog; the account follows each change and the Markdown file does too.',
    async (cue) => {
        await cue.defaults('speakerName', 'Andrii');
        // A note the account already has (made as another PC would have), for the app to restore at sign-in.
        cue.standIns({ FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT, FAKE_CLAUDE_SUMMARY: fixture('summaries', 'two-suggestions.md') });
        const backend = await cue.backend();
        const recorded = await recordCall(cue, backend, cue.email);
        const started = await makeNotes(backend, recorded);
        const note = await waitForNote(cue, backend, recorded.token, started.id);
        assertDeepEq(note.suggestions, { 'Participant 1': 'Petro Ivanenko', 'Participant 2': 'Olena Mulesa' });

        await cue.launch();
        await cue.waitLog(/☁️ Restored 1 note from your account/, 60);
        const account = await backend.accountOf(cue.email);

        // The page: both suggestions as chips, each with Apply and ✕.
        cue.control('page Bee talk/notes');
        const shown = async (pattern: RegExp): Promise<boolean> => pattern.test(await windowText(cue.pid));
        await cue.waitFor('the suggestions on the note’s page', 60, () => shown(/^Participant 2 → Olena Mulesa\?$/m));
        let page = await windowText(cue.pid);
        cue.save('page-suggestions.txt', page);
        assertTextContains(page, /^Participant 1 → Petro Ivanenko\?$/);
        assertTextContains(page, /^Apply Petro Ivanenko to Participant 1$/);
        assertTextContains(page, /^Dismiss the name suggested for Participant 2$/);
        assertTextContains(page, /^Reading room plan$/, 'the note’s title');
        assertTextContains(page, /^Participant 1 opened the call about the new reading room/, 'its summary');

        // ✕ on Participant 1’s: the suggestion goes, in the account, in the file and on the page.
        await press(cue.pid, 'Dismiss the name suggested for Participant 1');
        await cue.waitFor('the account to drop the suggestion', 20, async () => {
            const stored = (await account.notes())[0];
            return stored !== undefined && Object.keys(stored.suggestions).join() === 'Participant 2';
        });
        await cue.waitFor('the chip to go', 20, async () => !(await shown(/Petro Ivanenko\?/)));
        const notes = cue.findNotes()[0] ?? '';
        assertContains(notes, /^suggestions: \{"Participant 2": "Olena Mulesa"\}$/);
        assertContains(notes, /^participants: Andrii, Participant 1, Participant 2$/, 'dismissing renames nobody');

        // Apply on Participant 2’s: Olena Mulesa takes the label’s place everywhere.
        await press(cue.pid, 'Apply Olena Mulesa to Participant 2');
        await cue.waitLog(/✏️ Renamed “Participant 2” to “Olena Mulesa” in Reading room plan$/, 20);
        const applied = cue.findNotes()[0] ?? '';
        assertContains(applied, /^participants: Andrii, Participant 1, Olena Mulesa$/);
        assertNotContains(applied, /^suggestions:/, 'an applied suggestion goes');
        assertNotContains(applied, /Participant 2/, 'Olena Mulesa replaces the label everywhere');
        assertContains(applied, /^\*\*00:00:08 · Olena Mulesa\*\*$/);
        assertContains(cue.save('summary.md', summaryOf(applied)), /^- \[ \] Olena Mulesa: send the survey summary/);
        await cue.waitFor('the account to apply it', 20, async () => {
            const stored = (await account.notes())[0];
            return stored !== undefined && Object.keys(stored.suggestions).length === 0 && stored.participants.includes('Olena Mulesa');
        });
        await cue.waitFor('the page to show the name', 20, () => shown(/^Olena Mulesa$/m));
        page = await windowText(cue.pid);
        assertTextNotContains(page, /^Apply .* to /, 'no suggestion is left to apply');
        assertTextNotContains(page, /Participant 2/);

        // A click on a speaker’s name asks for the new one in a dialog; the name changes throughout.
        await press(cue.pid, 'Participant 1');
        await cue.waitFor('the rename dialog', 20, () => shown(/^Rename “Participant 1”$/m));
        await press(cue.pid, 'Name', 'Daniel Okonkwo');
        await press(cue.pid, 'Rename');
        await cue.waitLog(/✏️ Renamed “Participant 1” to “Daniel Okonkwo” in Reading room plan$/, 20);
        const renamed = cue.findNotes()[0] ?? '';
        assertContains(renamed, /^participants: Andrii, Daniel Okonkwo, Olena Mulesa$/);
        assertContains(renamed, /^\*\*00:00:01 · Daniel Okonkwo\*\*$/);
        assertContains(cue.save('summary-renamed.md', summaryOf(renamed)), /^Daniel Okonkwo opened the call about the new reading room/);
        await cue.waitFor('the account to have the new name', 20, async () => {
            const stored = (await account.notes())[0];
            return stored?.participants.includes('Daniel Okonkwo') === true && stored.summary.includes('Daniel Okonkwo opened');
        });
        await cue.waitFor('the page to show the new name', 20, () => shown(/^Daniel Okonkwo$/m));
        assertEq(cue.findNotes().length, 1, 'the note is changed, not copied');
    },
);
