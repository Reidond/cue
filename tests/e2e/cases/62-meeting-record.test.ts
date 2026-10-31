import {
    assertContains,
    assertEq,
    assertFile,
    assertNotContains,
    dialogue,
    e2eCase,
    fail,
    fixture,
    minutesFromNow,
    needWhisper,
    ocr,
} from '../harness/index.ts';

e2eCase(
    'Answering Record records the meeting into its project, named after the event with its attendees; once the ' +
        'call app has let go of the microphone for the release window, Cue stops and writes the notes.',
    async (cue) => {
        needWhisper();

        await cue.project('Research', { language: 'en' });
        cue.calendar([
            {
                id: 'sync-today',
                series: 'design-sync',
                title: 'Weekly design sync',
                recurring: true,
                start: minutesFromNow(-2),
                end: minutesFromNow(30),
                calendar: 'Work',
                url: 'https://meet.google.com/abc-defg-hij',
                attendees: ['Olena Mulesa', 'Petro Ivanenko'],
            },
        ]);
        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        const call = await dialogue(fixture('dialogues', 'meeting.txt'), cue.path('call'));
        await cue.launch({
            CUE_MEETING_TICK: '0.5',
            CUE_MIC_RELEASE: '4',
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            FAKE_DEEPGRAM_LIVE: call.live(),
            CUE_REHEARSE_ME: call.wav('me'),
        });

        cue.control('assign Weekly design sync | Research');
        cue.micApps('com.google.Chrome.helper');
        await cue.waitLog(/🔔 Record “Weekly design sync”\?/, 10);
        cue.control('notification record');
        await cue.waitLog(/📅 Recording “Weekly design sync” into Research/, 10);

        await cue.waitLog(/\*\*\[Participant\]\*\* .*next week/, 120);
        assertNotContains(cue.sessionLog(), /let go of the microphone/, 'the call is still on');
        // Chrome leaves the call.
        cue.micApps();
        const released = Date.now();
        await cue.waitLog(/📅 Google Chrome let go of the microphone — stopping the recording/, 20);
        const waited = (Date.now() - released) / 1000;
        if (waited < 3) fail(`the recording stopped ${waited.toFixed(1)}s after Chrome let go; the window is 4s`);
        await cue.waitLog(/Transcript saved: .*\/Documents\/Cue\/Research\/Notes\/[0-9 .-]+ – Weekly design sync\.md/, 30);
        await cue.waitLog(/Notes ready/, 60);
        await cue.waitLog(/🔔 Notes from “Weekly design sync” are ready/, 10);

        const notes = cue.readyNotes();
        assertFile(notes);
        assertEq(cue.findNotes().length, 1, 'expected exactly one notes file');
        assertContains(notes, /^title: "Weekly design sync"$/);
        assertContains(notes, /^event: "Weekly design sync"$/);
        assertContains(notes, /^attendees: \["Olena Mulesa", "Petro Ivanenko"\]$/);
        assertContains(notes, /^project: "Research"$/);
        assertContains(notes, /^audio: "[0-9 .-]+ – Weekly design sync\.m4a"$/);
        assertFile(`${notes.replace(/\.md$/, '')}.m4a`, "the call's audio is kept next to the note, under the event's name");
        assertContains(notes, /^# Weekly design sync$/);
        assertContains(notes, /onboarding screens/);
        assertContains(notes, /Thursday/);
        assertContains(notes, /^## Summary/);

        // The note's header lists who was invited.
        const render = await cue.cli('--render', notes, cue.path('notes.png'));
        if (render.code !== 0) fail(`--render exited with ${render.code}`, render.output);
        const rendered = cue.save('notes.txt', await ocr(cue.path('notes.png')));
        assertContains(rendered, /Olena Mulesa, Petro Ivanenko/);
        assertNotContains(rendered, /\["/, 'the attendees list is shown as names');

        const system = cue.save('summary-system.txt', cue.claudeRequests('summary-system').join(''));
        assertContains(system, /calendar event “Weekly design sync”/);
        assertContains(system, /Invited: Olena Mulesa, Petro Ivanenko/);
    },
);
