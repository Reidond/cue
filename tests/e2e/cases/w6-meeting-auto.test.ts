import { join } from 'node:path';
import {
    accountProject,
    assertContains,
    assertEq,
    assertFile,
    assertNotContains,
    bursts,
    e2eCase,
    fixture,
    listDir,
    minutesFromNow,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: with “Record automatically” a meeting is recorded without a prompt, into Meetings (created for it).',
    async (cue) => {
        // The talk Cue is bound to, in English; meetings go elsewhere.
        await accountProject(cue, 'Talk', { language: 'en', materials: [fixture('materials', 'talk.md')] });
        cue.calendar([
            {
                title: 'Product demo',
                start: minutesFromNow(-1),
                end: minutesFromNow(30),
                location: 'https://us02web.zoom.us/j/123456789?pwd=abc',
                attendees: ['Mia Chen'],
            },
        ]);
        await cue.defaults('meetingAction', 'record');
        await cue.defaults('autoAnswer', false);
        cue.micApps('zoom.exe');
        const others = await bursts(cue.path('others.wav'), 14, [[5, 7.5]]);
        const me = await bursts(cue.path('me.wav'), 14, [[9, 10.5]]);
        await cue.launch({
            CUE_PROJECT: 'Talk',
            CUE_MEETING_TICK: '0.5',
            CUE_MIC_RELEASE: '3',
            CUE_REHEARSE_PARTICIPANT: others,
            CUE_REHEARSE_ME: me,
            FAKE_DEEPGRAM_LIVE: JSON.stringify([
                { text: 'Shall we go through the onboarding screens before next week?', speaker: 0 },
                'I will finish them by Thursday.',
            ]),
            FAKE_DEEPGRAM_FILE: JSON.stringify({
                me: ['I will finish the onboarding screens by Thursday.'],
                others: [{ text: 'Shall we go through the onboarding screens before next week?', speaker: 0 }],
            }),
        });

        await cue.waitLog(/📅 Recording “Product demo” into Meetings/, 30);
        assertFile(join(cue.projectPath('Meetings'), 'project.json'), 'Meetings is created for the first meeting recording');
        await cue.waitLog(/\*\*\[Participant\]\*\* .*next week/, 120);
        cue.micApps();
        await cue.waitLog(/📅 Zoom let go of the microphone/, 20);
        await cue.waitLog(/Transcript saved: .*Documents\\Cue\\Meetings\\Notes\\[0-9 .-]+ – Product demo\.md/, 30);
        await cue.waitLog(/🔔 Notes from “Product demo” are ready/, 90);
        assertNotContains(cue.sessionLog(), /🔔 Record/, 'Record automatically doesn’t ask');

        const notes = cue.readyNotes();
        assertContains(notes, /^title: "Product demo"$/);
        assertContains(notes, /^project: "Meetings"$/);
        assertContains(notes, /^attendees: \["Mia Chen"\]$/);
        assertContains(notes, /onboarding screens/);
        // Meetings has the PC's language, but the call was recognized live in Talk's English: the second pass listens in English too.
        const asked = cue.serviceRequests('deepgram-file');
        assertEq(asked.length, 2, 'both sides should be read again');
        for (const request of asked) assertEq(request.query['language'], 'en', 'the second pass should use the live language');
        assertContains(cue.sessionLog(), /✅ Transcript improved/);
        assertEq(listDir(join(cue.projectPath('Talk'), 'Notes')).length, 0, 'the active project gets nothing');
    },
);
