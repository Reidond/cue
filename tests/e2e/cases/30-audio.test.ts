import { basename } from 'node:path';
import {
    afinfo,
    assertBetween,
    assertContains,
    assertEq,
    assertFile,
    audioLength,
    audioSync,
    CLAUDE,
    dialogue,
    e2eCase,
    fail,
    findFiles,
    fixture,
    lines,
    matches,
    needWhisper,
    print,
} from '../harness/index.ts';

e2eCase(
    'A recorded call keeps its audio next to the notes: AAC as long as the call, both sides in sync, named in ' +
        'the front matter and renamed with the notes after the summary.',
    async (cue) => {
        needWhisper();

        await cue.defaults('speakerName', 'Andrii Test');
        await cue.project('Interviews', { language: 'en' });
        const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
        await cue.launch({
            CUE_PROJECT: 'Interviews',
            CUE_REHEARSE_RECORD: '1',
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            CUE_REHEARSE_ME: call.wav('me'),
        });
        await cue.waitLog(/Transcript saved/, 120);
        await cue.waitLog(/Audio saved: .*\/Documents\/Cue\/Interviews\/Notes\/.*\.m4a \([0-9]+:[0-9]{2}\)/, 10);
        await cue.waitLog(/Notes ready/, 180);
        const steps = matches(cue.sessionLog(), /Transcript saved|Audio saved|Notes ready/).join(',');
        assertEq(
            steps,
            'Transcript saved,Audio saved,Notes ready',
            `the audio should be saved after the transcript and before the notes are ready: ${steps}`,
        );

        const notes = cue.readyNotes();
        const audio = `${notes.replace(/\.md$/, '')}.m4a`;
        assertFile(audio, `the audio should be next to the notes, named like them: ${audio}`);
        assertEq(findFiles(cue.documents, /\.m4a$/).length, 1, 'expected exactly one audio file');
        if (!lines(notes).includes(`audio: "${basename(audio)}"`)) {
            fail('the front matter should name the audio', lines(notes).slice(0, 12).join('\n'));
        }
        if (CLAUDE === 'fake' && !basename(audio).endsWith(' – E2E rehearsal notes.m4a')) {
            fail(`the audio should be renamed with the notes: ${basename(audio)}`);
        }

        // Playable AAC, 16 kHz mono, as long as the recording: the call, the rehearsal's 3 s of
        // trailing silence and the second before it stops.
        const info = await afinfo(audio);
        const infoFile = cue.save('afinfo.txt', info.output);
        if (info.code !== 0) fail("afinfo can't read the audio", info.output);
        assertContains(infoFile, /File type ID: +m4af/);
        assertContains(infoFile, /1 ch, +16000 Hz, aac/);
        const callLength = (await audioLength(call.wav('call'))) ?? fail("afinfo can't read the call's length");
        const length = await audioLength(audio);
        assertBetween(
            length,
            callLength + 3,
            callLength + 6,
            `the audio should last the recording (call ${callLength} s + 4 s), not ${length} s`,
        );

        // Both sides where the dialogue has them, silence in between.
        const sync = await audioSync(audio, call.timeline);
        cue.save('sync.txt', sync.output);
        if (!sync.ok) fail('the two sides should be in sync', sync.output);
        print(sync.output);

        // The transcript's timestamps are times in the audio (timeline: 0.50 call, 5.35 me, 9.24 call, 12.48 me).
        assertContains(notes, /^\*\*00:00:00 · Participant\*\*$/);
        assertContains(notes, /^\*\*00:00:05 · Andrii Test\*\*$/);
        assertContains(notes, /^\*\*00:00:09 · Participant\*\*$/);
        assertContains(notes, /^\*\*00:00:12 · Andrii Test\*\*$/);
    },
);
