import {
    accountProject,
    assertContains,
    assertEq,
    bursts,
    clickToast,
    e2eCase,
    fixture,
    minutesFromNow,
    needWindowsOcr,
    skip,
    sleep,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: Record on the notification Windows really shows (clicked as a hand would) starts the recording in the meeting’s project, ' +
        'and the notes are written when the call app lets go of the microphone.',
    async (cue) => {
        await needWindowsOcr();
        await accountProject(cue, 'Research', { language: 'en', materials: [fixture('materials', 'talk.md')] });
        cue.calendar([
            {
                id: 'sync-today',
                series: 'design-sync',
                title: 'Weekly design sync',
                recurring: true,
                start: minutesFromNow(-2),
                end: minutesFromNow(30),
                url: 'https://meet.google.com/abc-defg-hij',
                attendees: ['Olena Mulesa'],
            },
        ]);
        await cue.defaults('autoAnswer', false);
        const others = await bursts(cue.path('others.wav'), 14, [[5, 7.5]]);
        const me = await bursts(cue.path('me.wav'), 14, [[9, 10.5]]);
        await cue.launch({
            CUE_PROJECT: 'Research',
            CUE_MEETING_TICK: '0.5',
            CUE_MIC_RELEASE: '3',
            // The notification is Windows' own, not only a line in the log.
            CUE_SYSTEM_NOTIFICATIONS: '1',
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
        cue.control('assign Weekly design sync | Research');
        cue.micApps('chrome.exe');
        await cue.waitLog(/🔔 Record “Weekly design sync”\?/, 10);
        assertEq(cue.logCount(/Notifications unavailable|Couldn't show a notification/), 0, 'Windows took the notification');

        // The banner stays about five seconds: look for its Record button every second until it is there, and click it.
        let clicked = false;
        for (let waited = 0; waited < 20 && !clicked; waited++) {
            clicked = await clickToast('Record');
            if (!clicked) await sleep(1);
        }
        if (!clicked)
            skip(
                'Windows showed no notification banner with a Record button in this session (a runner without a shell that shows toasts, or Focus assist), so it can’t be clicked',
            );
        await cue.waitLog(/📅 Recording “Weekly design sync” into Research/, 30);
        await cue.waitLog(/⏺ Recording started \(Record in the notification\)/, 10);

        await cue.waitLog(/\*\*\[Participant\]\*\* .*next week/, 120);
        cue.micApps();
        await cue.waitLog(/📅 Google Chrome let go of the microphone — stopping the recording/, 20);
        await cue.waitLog(/Notes ready/, 90);
        const notes = cue.readyNotes();
        assertContains(notes, /^title: "Weekly design sync"$/);
        assertContains(notes, /^project: "Research"$/);
        assertContains(notes, /^attendees: \["Olena Mulesa"\]$/);
    },
);
