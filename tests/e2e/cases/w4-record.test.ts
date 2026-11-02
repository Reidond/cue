import { basename } from 'node:path';
import {
    accountProject,
    assertBetween,
    assertContains,
    assertEq,
    assertFile,
    assertNotContains,
    assertTextContains,
    assertTextNotContains,
    bursts,
    e2eCase,
    fail,
    findFiles,
    fixture,
    hasAudioOutput,
    LIVE_SCRIPT,
    matches,
    RECORDED_SCRIPT,
    windowText,
} from '../harness/index.ts';
import { statSync } from 'node:fs';

e2eCase(
    'Cue for Windows: a two-sided rehearsal is recorded into notes (the live transcript saved at once, the audio next to it, then the second pass, the ' +
        'voices told apart and a summary and a title from the account), and the project’s Notes page shows the note.',
    async (cue) => {
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        // The call speaks twice (a voice each) and the person once, as `RECORDED_SCRIPT` and `LIVE_SCRIPT` say.
        const others = await bursts(cue.path('others.wav'), 12, [
            [1, 3.5],
            [8, 10],
        ]);
        const me = await bursts(cue.path('me.wav'), 12, [[5, 6.5]]);
        await cue.launch({
            CUE_PROJECT: 'Bees',
            CUE_REHEARSE_RECORD: '1',
            CUE_REHEARSE_PARTICIPANT: others,
            CUE_REHEARSE_ME: me,
            FAKE_DEEPGRAM_LIVE: LIVE_SCRIPT,
            FAKE_DEEPGRAM_FILE: RECORDED_SCRIPT,
        });
        await cue.waitLog(/⏺ Recording started \(rehearsal\)/, 120);
        await cue.waitLog(/Transcript saved/, 60);
        await cue.waitLog(/Notes ready/, 180);

        // The session log tells every step, in order.
        const log = cue.sessionLog();
        const steps = matches(
            log,
            /Recording started|Recording stopped|Transcript saved|Audio saved|Working audio:|Uploading the recording…|Recording uploaded|Improving transcript…|Transcript improved|Finding speakers…|Speakers: 2|Writing summary…|Notes ready|Working audio removed/,
        ).join(',');
        assertEq(
            steps,
            'Recording started,Recording stopped,Transcript saved,Audio saved,Working audio:,Uploading the recording…,Recording uploaded,Improving transcript…,Transcript improved,Finding speakers…,Speakers: 2,Writing summary…,Notes ready,Working audio removed',
            `every step should be told, in order: ${steps}`,
        );
        assertContains(log, /⏹ Recording stopped after 0:1[0-9] \(rehearsal\)/);
        assertContains(log, /🔊 Audio saved: .*\.m4a \(0:1[0-9]\)/);
        assertContains(log, /⬆️ Recording uploaded: [0-9.]+ MB/);

        // The note in Documents: the second pass's transcript with the voices told apart, the summary, the title it was named after.
        const notes = cue.readyNotes();
        assertFile(notes);
        assertEq(cue.findNotes().length, 1, 'expected exactly one notes file');
        if (!basename(notes).endsWith(' – E2E rehearsal notes.md')) fail(`the file should be renamed after the summary's title: ${basename(notes)}`);
        assertContains(notes, /^title: "E2E rehearsal notes"$/);
        assertContains(notes, /^participants: Andrii Test, Participant 1, Participant 2$/);
        assertContains(notes, /^project: "Bees"$/);
        assertContains(notes, /^note: [0-9a-z-]+$/, "the account's id of the note");
        assertContains(notes, /^## Transcript$/);
        assertContains(notes, /^\*\*00:00:0[0-2] · Participant 1\*\*$/);
        assertContains(notes, /^\*\*00:00:05 · Andrii Test\*\*$/);
        assertContains(notes, /^\*\*00:00:08 · Participant 2\*\*$/);
        assertContains(notes, /^## Summary/);
        assertNotContains(notes, /^_…_$/, 'the summary placeholder should be replaced');

        // The audio next to the note, under its name, and named in its front matter; the working copies are gone.
        const audio = `${notes.replace(/\.md$/, '')}.m4a`;
        assertFile(audio, 'the mixed audio should be next to the note');
        assertContains(notes, new RegExp(`^audio: "${basename(audio).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`));
        assertBetween(statSync(audio).size, 5_000, 2_000_000, 'about 15 seconds of AAC');
        assertEq(findFiles(cue.home, /\.wav$/).length, 0, 'the working audio should be removed once the notes are ready');

        // Both sides reached the second pass, as long as the recording.
        const asked = cue.serviceRequests('deepgram-file');
        assertEq(asked.length, 2, 'both sides should be read once');
        for (const request of asked) assertBetween(request.seconds, 13, 19, `the whole ${request.side} recording should have gone up`);

        // The account has the note: ready, both sides of the transcript, the audio for playing.
        const account = await (await cue.backend()).accountOf(cue.email);
        const stored = await account.notes();
        assertEq(stored.length, 1, 'the account should have the one note');
        assertEq(stored[0]?.title, 'E2E rehearsal notes');
        assertEq(stored[0]?.status, 'ready');
        assertEq(stored[0]?.transcript.some((turn) => turn.channel === 'me') && stored[0]?.transcript.some((turn) => turn.channel === 'others'), true);
        assertEq(stored[0]?.audio.includes('mixed'), true, 'the mixed audio went up for playing');

        // Stop opened the note on the dashboard, and its page reads like the file: no steps left, since nothing failed.
        cue.control('page Bees/notes');
        await cue.waitFor('the note on its page', 60, async () => /^E2E rehearsal notes$/m.test(await windowText(cue.pid)));
        const page = await windowText(cue.pid);
        cue.save('notes-page.txt', page);
        assertTextContains(page, /^Summary$/);
        assertTextContains(page, /^Andrii Test$/, 'the speakers are named');
        assertTextContains(page, /^Participant 1$/);
        assertTextContains(page, /^Participant 2$/);
        assertTextContains(page, /^00:00:05$/, 'a timestamp to play from');
        assertTextContains(page, /^Record$/, 'the record button');
        assertTextNotContains(page, /^Improving transcript$/, 'the steps leave the page once nothing failed');
        assertTextNotContains(page, /^Saving audio$/);

        // The timestamp plays the audio from there (where there is a sound device to play it through).
        if (await hasAudioOutput()) {
            cue.control('timestamp 00:00:05');
            await cue.waitLog(/▶︎ Playing .*\.m4a from 0:05 \(player at 5\.0 s\)/, 30);
            await cue.waitFor('the player to be playing', 20, async () => /^Pause$/m.test(await windowText(cue.pid)));
        }
    },
);
