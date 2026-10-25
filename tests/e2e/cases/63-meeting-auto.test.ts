import { join } from 'node:path';
import {
    assertContains, assertEq, assertFile, assertNotContains, dialogue, e2eCase, fixture, lines, listDir, minutesFromNow,
    needWhisper,
} from '../harness/index.ts';

e2eCase('With "Record automatically" a meeting is recorded without a prompt, into Meetings (created for it).', async (cue) => {
    needWhisper();
    const whisperCli = await cue.whisperCliSpy();

    // The talk Cue is bound to, in English; meetings go elsewhere.
    await cue.project('Talk', { language: 'en' });
    cue.calendar([
        {
            title: 'Product demo', start: minutesFromNow(-1), end: minutesFromNow(30),
            location: 'https://us02web.zoom.us/j/123456789?pwd=abc', attendees: ['Mia Chen'],
        },
    ]);
    await cue.defaults('meetingAction', 'record');
    await cue.defaults('autoAnswer', false);
    cue.micApps('us.zoom.xos');
    const call = await dialogue(fixture('dialogues', 'meeting.txt'), cue.path('call'));
    await cue.launch({
        CUE_MEETING_TICK: '0.5', CUE_MIC_RELEASE: '3', CUE_WHISPER_CLI: whisperCli,
        CUE_REHEARSE_PARTICIPANT: call.wav('call'), CUE_REHEARSE_ME: call.wav('me'),
    });

    await cue.waitLog(/📅 Recording “Product demo” into Meetings/, 10);
    assertFile(join(cue.projectPath('Meetings'), 'project.json'), 'Meetings is created for the first meeting recording');
    await cue.waitLog(/\*\*\[Participant\]\*\* .*next week/, 120);
    cue.micApps();
    await cue.waitLog(/📅 Zoom let go of the microphone/, 20);
    await cue.waitLog(/Transcript saved: .*\/Documents\/Cue\/Meetings\/Notes\/[0-9 .-]+ – Product demo\.md/, 30);
    await cue.waitLog(/🔔 Notes from “Product demo” are ready/, 60);
    assertNotContains(cue.sessionLog(), /🔔 Record/, "Record automatically doesn't ask");

    const notes = cue.readyNotes();
    assertContains(notes, /^title: "Product demo"$/);
    assertContains(notes, /^project: "Meetings"$/);
    assertContains(notes, /^attendees: \["Mia Chen"\]$/);
    assertContains(notes, /onboarding screens/);
    // Meetings has the system language, but the call was recognized live in Talk's English: the second
    // pass listens in English too, and its transcript is the one kept.
    const args = lines(cue.path('whisper-args.txt'));
    const language = args.includes('-l') ? args[args.lastIndexOf('-l') + 1] ?? '-l' : '';
    assertEq(language, 'en', 'the second pass should use the live language');
    assertContains(cue.sessionLog(), /✅ Transcript improved/);
    assertEq(listDir(join(cue.projectPath('Talk'), 'Notes')).length, 0, 'the active project gets nothing');
});
