import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    accountProject,
    assertContains,
    assertEq,
    assertFile,
    assertNotContains,
    bursts,
    e2eCase,
    findFiles,
    fixture,
    press,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: with Keep audio and the summary switched off in Settings › General, a recording’s notes have no audio and no summary (the sides still ' +
        'go up for the second pass, and are deleted from the account and from the PC once the notes are ready), and the switches change the settings.',
    async (cue) => {
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        await cue.defaults('keepAudio', false);
        await cue.defaults('summarizeRecordings', false);
        const others = await bursts(cue.path('others.wav'), 7, [[1, 3.5]]);
        const me = await bursts(cue.path('me.wav'), 7, [[4.5, 6]]);
        await cue.launch({
            CUE_PROJECT: 'Bees',
            CUE_REHEARSE_RECORD: '1',
            CUE_REHEARSE_PARTICIPANT: others,
            CUE_REHEARSE_ME: me,
            FAKE_DEEPGRAM_LIVE: JSON.stringify([{ text: 'Good morning, when is the report?', speaker: 0 }, 'I will send it by Friday.']),
            FAKE_DEEPGRAM_FILE: JSON.stringify({
                me: ['I will send the report by Friday.'],
                others: [{ text: 'Good morning. When is the report due?', speaker: 0 }],
            }),
        });
        await cue.waitLog(/Transcript saved/, 120);
        await cue.waitLog(/Audio not kept \(Keep audio is off\): [0-9]+:[0-9]{2}/, 10);
        await cue.waitLog(/Working audio: .*\\recordings\\/, 10);
        await cue.waitLog(/Notes ready/, 180);
        await cue.waitLog(/Working audio removed: /, 5);

        const log = cue.sessionLog();
        assertNotContains(log, /Audio saved/);
        assertNotContains(log, /Writing summary/, 'no summary is asked for');

        // The note: the second pass's transcript, no audio, no summary.
        const notes = cue.readyNotes();
        assertFile(notes);
        assertContains(notes, /^## Transcript$/);
        assertContains(notes, /^\*\*00:00:04 · Andrii Test\*\*$/);
        assertNotContains(notes, /^audio/, 'the notes name no audio');
        assertNotContains(notes, /^## Summary/, 'and have no summary');
        assertEq(findFiles(cue.home, /\.(m4a|wav)$/).length, 0, 'no audio should be left anywhere on the PC');

        // The sides went up to be read again; the account deletes them once the notes are ready, and the mixed audio never went up.
        const backend = await cue.backend();
        const account = await backend.accountOf(cue.email);
        await cue.waitFor('the audio to be gone from the account', 30, async () => (await account.notes())[0]?.audio.length === 0);
        assertEq(
            backend.objects().filter((key) => key.includes('/calls/')).length,
            0,
            'the account’s storage should hold no recording (the project’s materials are another matter)',
        );

        // The switches in Settings are the preferences.
        const settings = (): { keepAudio?: boolean; summarizeRecordings?: boolean } =>
            JSON.parse(readFileSync(join(cue.support, 'settings.json'), 'utf8')) as { keepAudio?: boolean; summarizeRecordings?: boolean };
        // (As tall as the screen allows: the Notes group is under Answers, and UI Automation sees only what is scrolled into view.)
        cue.control('size 1100 1400');
        cue.control('settings general');
        await cue.waitFor('the switches', 30, async () => {
            await press(cue.pid, 'Keep audio');
            return true;
        });
        await cue.waitFor('Keep audio to be on', 20, () => settings().keepAudio === true);
        await press(cue.pid, 'Write a summary of each call');
        await cue.waitFor('the summary to be on', 20, () => settings().summarizeRecordings === true);
    },
);
