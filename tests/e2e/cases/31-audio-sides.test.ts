import { join } from 'node:path';
import {
    afinfo,
    assertBetween,
    assertContains,
    assertEq,
    assertFile,
    audioLength,
    audioSync,
    dialogue,
    e2eCase,
    exists,
    fail,
    fixture,
    lines,
    matches,
    print,
    sameFile,
} from '../harness/index.ts';

e2eCase(
    'While a note is processed, each side of the call is in its own WAV (16-bit, 16 kHz) in a working folder ' +
        "named after the note's date, in sync with the call; the folder goes once the notes are ready.",
    async (cue) => {
        await cue.project('Interviews', { language: 'en' });
        const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
        // A summary that takes a while, as the real one does, so the working copies can be checked meanwhile.
        await cue.launch({
            CUE_PROJECT: 'Interviews',
            CUE_REHEARSE_RECORD: '1',
            FAKE_CLAUDE_SUMMARY_DELAY: '10',
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            FAKE_DEEPGRAM_LIVE: call.live(),
            FAKE_DEEPGRAM_FILE: call.file(),
            CUE_REHEARSE_ME: call.wav('me'),
        });
        await cue.waitLog(/Working audio: /, 150);
        const log = cue.sessionLog();
        const folder = (matches(log, /Working audio: .*/)[0] ?? '').replace(/^Working audio: (.*) \(mic\.wav, call\.wav\)$/, '$1');
        const notes = (matches(log, /Transcript saved: .*/)[0] ?? '').slice('Transcript saved: '.length);
        assertFile(notes);

        // Found from the note: Application Support/Cue/recordings/<the note's date: without colons>.
        const stamp = (lines(notes).find((line) => line.startsWith('date: ')) ?? '').slice('date: '.length).replaceAll(':', '');
        if (!sameFile(folder, join(cue.support, 'recordings', stamp))) {
            fail(`the working audio should be in recordings/${stamp}, not ${folder}`);
        }
        if (cue.logCount(/Notes ready/) > 0) fail("the notes shouldn't be ready yet; the summary is still being written");

        for (const side of ['mic', 'call']) {
            const wav = join(folder, `${side}.wav`);
            assertFile(wav);
            const info = cue.save(`${side}.txt`, (await afinfo(wav)).stdout);
            assertContains(info, /File type ID: +WAVE/);
            assertContains(info, /1 ch, +16000 Hz, Int16/);
        }
        assertEq(
            await audioLength(join(folder, 'mic.wav')),
            await audioLength(join(folder, 'call.wav')),
            'both sides should be as long as the recording',
        );
        const callLength = (await audioLength(call.wav('call'))) ?? fail("afinfo can't read the call's length");
        assertBetween(await audioLength(join(folder, 'call.wav')), callLength + 3, callLength + 6);

        // Each side has only its own lines, where the dialogue has them.
        const mic = await audioSync(join(folder, 'mic.wav'), call.timeline, 'me');
        cue.save('sync-mic.txt', mic.output);
        if (!mic.ok) fail('mic.wav should have your lines, in place, and nothing else', mic.output);
        const callSide = await audioSync(join(folder, 'call.wav'), call.timeline, 'call');
        cue.save('sync-call.txt', callSide.output);
        if (!callSide.ok) fail("call.wav should have the participant's lines, in place, and nothing else", callSide.output);
        print(mic.output, callSide.output);

        await cue.waitLog(/Notes ready/, 60);
        await cue.waitLog(/Working audio removed: /, 5);
        if (exists(folder)) fail('the working audio should be gone once the notes are ready');
        assertFile(cue.readyNotes());
    },
);
