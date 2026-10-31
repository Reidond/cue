import {
    assertContains,
    assertEq,
    assertFile,
    assertNotContains,
    dialogue,
    e2eCase,
    fail,
    fixture,
    literal,
    matches,
    needWhisper,
    readText,
} from '../harness/index.ts';

e2eCase(
    "When the second pass can't run (here whisper-cli is missing), the note keeps the live transcript, its page " +
        'and the session log say what went wrong, and the summary is written all the same.',
    async (cue) => {
        needWhisper();

        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        await cue.project('Interviews', { language: 'en' });
        const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
        const missing = cue.path('nowhere', 'whisper-cli');
        await cue.launch({
            CUE_PROJECT: 'Interviews',
            CUE_REHEARSE_RECORD: '1',
            CUE_WHISPER_CLI: missing,
            CUE_SNAPSHOT: cue.path('cue.png'),
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            FAKE_DEEPGRAM_LIVE: call.live(),
            CUE_REHEARSE_ME: call.wav('me'),
        });
        await cue.waitLog(/Notes ready/, 180);

        const log = cue.sessionLog();
        assertContains(
            log,
            new RegExp(`⚠︎ Couldn't improve the transcript: whisper-cli not found at ${literal(missing)} — the live transcript is kept$`),
        );
        assertNotContains(log, /Transcript improved/);
        const steps = matches(
            log,
            /Transcript saved|Improving transcript…|Couldn't improve the transcript|Writing summary…|Notes ready/,
        ).join(',');
        assertEq(
            steps,
            "Transcript saved,Improving transcript…,Couldn't improve the transcript,Writing summary…,Notes ready",
            `the summary should still be written after the failed step: ${steps}`,
        );

        // The note has the live transcript: every line the live recognition heard, as it heard it.
        const notes = cue.readyNotes();
        assertFile(notes);
        const live = matches(log, /\*\*\[(Participant|Andrii Test)\]\*\* .*/).map((line) => line.replace(/^\*\*\[[^\]]+\]\*\* /, ''));
        cue.save('live.txt', live.map((line) => `${line}\n`).join(''));
        assertEq(live.length, 4, 'live recognition should have heard the four lines');
        const text = readText(notes) ?? '';
        for (const line of live) {
            if (!text.includes(line)) fail(`the note should keep the live line: ${line}`);
        }
        assertContains(notes, /^\*\*00:00:05 · Andrii Test\*\*$/);

        // The summary is there, and the note is named after it.
        assertContains(notes, /^## Summary/);
        assertContains(notes, /^title: "E2E rehearsal notes"/);

        // The note's page keeps its steps, with what went wrong.
        // The reason's first line, with the sandbox's long path, is the one Vision may garble ("vhisper-cli not found at /var|…").
        await cue.dashboardPage('Interviews/notes', /not found at/);
        const page = cue.page;
        assertContains(page, /whisper-cli/);
        assertContains(page, /Saving audio$/);
        assertContains(page, /Improving transcript$/);
        assertContains(page, /transcript is kept/);
        assertContains(page, /Writing summary$/);
        assertContains(page, /^Summary$/);
    },
);
