import {
    assertContains,
    assertEq,
    assertFile,
    assertNotContains,
    dialogue,
    e2eCase,
    fail,
    fixture,
    matches,
    needWhisper,
    needWhisperCli,
    readText,
    shellQuote,
    writeExecutable,
} from '../harness/index.ts';

e2eCase(
    'A second pass that hears far less than live recognition did (here whisper-cli only gets the first second ' +
        "of each side) doesn't replace the live transcript: the note keeps it and says why.",
    async (cue) => {
        needWhisper();
        const realWhisperCli = needWhisperCli();
        const whisperCli = await writeExecutable(
            cue.path('whisper-cli'),
            `#!/bin/bash\nexec ${shellQuote(realWhisperCli)} "$@" --duration 1000\n`,
        );

        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        await cue.project('Interviews', { language: 'en' });
        const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
        await cue.launch({
            CUE_PROJECT: 'Interviews',
            CUE_REHEARSE_RECORD: '1',
            CUE_WHISPER_CLI: whisperCli,
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            CUE_REHEARSE_ME: call.wav('me'),
        });
        await cue.waitLog(/Notes ready/, 180);

        const log = cue.sessionLog();
        assertContains(
            log,
            /⚠︎ Couldn't improve the transcript: it heard much less than live recognition on (your side|the call side) — the live transcript is kept$/,
        );
        assertNotContains(log, /Transcript improved/);

        // Every line live recognition heard is in the note, as it heard it.
        const notes = cue.readyNotes();
        assertFile(notes);
        const live = matches(log, /\*\*\[(Participant|Andrii Test)\]\*\* .*/).map((line) => line.replace(/^\*\*\[[^\]]+\]\*\* /, ''));
        cue.save('live.txt', live.map((line) => `${line}\n`).join(''));
        assertEq(live.length, 4, 'live recognition should have heard the four lines');
        const text = readText(notes) ?? '';
        for (const line of live) {
            if (!text.includes(line)) fail(`the note should keep the live line: ${line}`);
        }
        assertContains(notes, /^## Summary/);
    },
);
