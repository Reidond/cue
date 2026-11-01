import { rm } from 'node:fs/promises';
import { assertContains, assertEq, assertNotContains, dialogue, e2eCase, fixture, sleep } from '../harness/index.ts';

e2eCase(
    'A renamed speaker stays renamed across launches: with the library gone (a new Mac, or notes deleted), the note comes ' +
        'back from the account under its new name, in the transcript, the summary, the title and the participants.',
    async (cue) => {
        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        await cue.project('Library', { language: 'en' });
        const call = await dialogue(fixture('dialogues', 'two-voices.txt'), cue.path('call'));
        await cue.launch({
            CUE_PROJECT: 'Library',
            CUE_REHEARSE_RECORD: '1',
            FAKE_CLAUDE_SUMMARY: fixture('summaries', 'speaker-rename.md'),
            CUE_SNAPSHOT: cue.path('cue.png'),
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            FAKE_DEEPGRAM_LIVE: call.live(),
            FAKE_DEEPGRAM_FILE: call.file(),
            CUE_REHEARSE_ME: call.wav('me'),
        });
        await cue.waitLog(/Notes ready/, 300);

        await cue.dashboardPage('Library/notes', /Participant 1 opened the call/);
        cue.control('rename Participant 1 | Petro Ivanenko');
        await cue.waitLog(/✏️ Renamed “Participant 1” to “Petro Ivanenko” in Reading room plan with Participant 1$/, 10);
        const account = await (await cue.backend()).accountOf(cue.email);
        await cue.waitFor(
            'the account to have the new name',
            20,
            async () => (await account.notes())[0]?.participants.includes('Petro Ivanenko') === true,
        );

        // Quit, and lose the notes (and the audio) in the library.
        await cue.stop();
        for (const file of [...cue.findNotes(), ...cue.findNotes().map((note) => note.replace(/\.md$/, '.m4a'))])
            await rm(file, { force: true });
        assertEq(cue.findNotes().length, 0, 'the library should have no notes left');

        // The next launch gets the note back from the account.
        await sleep(1); // session logs are named by the second
        await cue.launch();
        await cue.waitLog(/☁️ Restored 1 notes? from your account/, 60);
        await cue.waitFor('the note to be back in the library', 20, () => cue.findNotes().length === 1);
        const notes = cue.findNotes()[0] ?? '';
        assertContains(notes, /^title: "Reading room plan with Petro Ivanenko"$/);
        assertContains(notes, /^participants: Andrii Test, Petro Ivanenko, Participant 2$/);
        assertContains(notes, /^\*\*[0-9:]+ · Petro Ivanenko\*\*$/);
        assertContains(notes, /^Petro Ivanenko opened the call about the new reading room\./);
        assertNotContains(notes, /Participant 1([^0-9]|$)/, 'the old name should not come back');
    },
);
