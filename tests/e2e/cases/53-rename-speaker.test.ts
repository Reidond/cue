import { basename } from 'node:path';
import {
    assertContains,
    assertEq,
    assertFile,
    assertNotContains,
    dialogue,
    e2eCase,
    fail,
    findFiles,
    fixture,
    labelsOf,
    lines,
    print,
    summaryOf,
    turnSpeakers,
} from '../harness/index.ts';

e2eCase(
    "Renaming a speaker on the note's page (clicking their name) renames them throughout the note: the " +
        'transcript, the summary, the title (and so the file and its audio) and the participants, as whole words only; ' +
        'the others keep their labels.',
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
        await cue.waitLog(/✅ Speakers: 2 /, 1);
        const before = cue.readyNotes();
        if (!basename(before).endsWith(' – Reading room plan with Participant 1.md')) {
            fail(`the note should be named after the summary: ${basename(before)}`);
        }

        await cue.dashboardPage('Library/notes', /Participant 1 opened the call/);
        cue.control('rename Participant 1 | Petro Ivanenko');
        await cue.waitLog(/✏️ Renamed “Participant 1” to “Petro Ivanenko” in Reading room plan with Participant 1$/, 10);

        assertEq(cue.findNotes().length, 1, 'the note is renamed, not copied');
        const notes = cue.findNotes()[0] ?? '';
        if (!basename(notes).endsWith(' – Reading room plan with Petro Ivanenko.md')) {
            fail(`the note should take its new title: ${basename(notes)}`);
        }
        const audio = `${notes.replace(/\.md$/, '')}.m4a`;
        assertFile(audio, 'the audio should be renamed with the note');
        assertEq(findFiles(cue.documents, /\.m4a$/).length, 1, 'expected exactly one audio file');
        if (!lines(notes).includes(`audio: "${basename(audio)}"`)) fail('the front matter should name the renamed audio');
        assertContains(notes, /^title: "Reading room plan with Petro Ivanenko"$/);
        assertContains(notes, /^# Reading room plan with Petro Ivanenko$/);
        assertContains(notes, /^participants: Andrii Test, Petro Ivanenko, Participant 2$/);

        // The summary: every mention of the name, and nothing that only looks like it.
        const summary = cue.save('summary.md', summaryOf(notes));
        assertContains(summary, /^Petro Ivanenko opened the call about the new reading room\. Participant 2 summed up/);
        assertContains(summary, /Petro Ivanenko's next meeting is on Monday\.$/);
        assertContains(summary, /^- Participants asked for more quiet desks\.$/);
        assertContains(summary, /^- \[ \] Participant 2: send the survey summary/);
        assertNotContains(notes, /Participant 1([^0-9]|$)/, 'no mention of the old name should be left');

        // The transcript: Daniel's lines are Petro Ivanenko's now, Karen's still Participant 2's.
        const speakers = turnSpeakers(notes, call.timeline);
        cue.save('speakers.tsv', speakers);
        print(speakers);
        assertEq(labelsOf(speakers, 'Daniel'), 'Petro Ivanenko');
        assertEq(labelsOf(speakers, 'Karen'), 'Participant 2');
        assertEq(labelsOf(speakers, 'Samantha'), 'Andrii Test');

        // The account has the new name too, not only the file on this Mac.
        const account = await (await cue.backend()).accountOf(cue.email);
        await cue.waitFor('the account to have the new name', 20, async () => {
            const stored = (await account.notes())[0];
            return stored?.participants.includes('Petro Ivanenko') === true && stored.title === 'Reading room plan with Petro Ivanenko';
        });

        // The open note shows the new name.
        await cue.waitFor('the page to show the new name', 20, () => cue.dashboardShows(/^Petro Ivanenko opened the call/));
        assertContains(cue.page, /^Petro Ivanenko( 00:[0-9:]+)?$/);
    },
);
