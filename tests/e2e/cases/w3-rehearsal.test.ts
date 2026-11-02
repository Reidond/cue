import {
    accountProject,
    assertContains,
    assertTextContains,
    bursts,
    e2eCase,
    fixture,
    needWindowsOcr,
    windowText,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows: a rehearsal (a recording played as the call) shows the live transcript, the question, its prepared match and its streamed answer ' +
        'on the overlay, and the overlay is in the snapshot.',
    async (cue) => {
        await needWindowsOcr();
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        const call = await bursts(cue.path('call.wav'), 9, [[1, 3.5]]);
        await cue.launch({
            CUE_PROJECT: 'Bees',
            CUE_REHEARSE_PARTICIPANT: call,
            FAKE_DEEPGRAM_LIVE: JSON.stringify(['Thank you for the talk. How many hives did you study?']),
            FAKE_CLAUDE_ANSWER: 'We studied 48 hives on six rooftops.\n- 48 hives, 6 rooftops\nSource: talk.md',
            CUE_SNAPSHOT: cue.path('cue.png'),
        });
        // The rehearsal starts Cue as soon as someone is signed in, and plays once the call's socket is up and Claude, the question judge and
        // speech recognition are warm.
        await cue.waitLog(/📞 Live call started/, 60);
        await cue.waitLog(/🧐 Question judge ready: Claude Haiku/, 90);
        await cue.waitLog(/\*\*\[Participant\]\*\* Thank you for the talk/, 90);
        await cue.waitLog(/❓ \*\*Question:\*\* How many hives did you study\?/, 60);
        await cue.waitLog(/Answer\*\* \(/, 60);

        const log = cue.sessionLog();
        assertContains(log, /prepared match [0-9]+%/);
        assertContains(log, /▶︎ Cue started: Bees/);
        assertContains(log, /🎤 Listening/);
        assertContains(log, /We studied 48 hives on six rooftops/);

        // What the overlay shows, as UI Automation reads it.
        const text = await windowText(cue.pid);
        cue.save('overlay.txt', text);
        assertTextContains(text, /^How many hives did you study\?$/, 'the question');
        assertTextContains(text, /^We studied 48 hives on six rooftops\.$/, 'what to say');
        assertTextContains(text, /^48 hives, 6 rooftops$/, 'the point');
        assertTextContains(text, /^talk\.md$/, 'the source');
        assertTextContains(text, /Thank you for the talk\. How many hives did you study\?/, 'the transcript');
        assertTextContains(text, /^Listening$/, 'the status line');
        assertTextContains(text, /^Bees$/, 'the project');

        // The snapshot has the overlay too (CUE_SNAPSHOT lets screenshots see it).
        await cue.waitLog(/📸 Snapshots: window capture/, 30);
        const snapshot = cue.save('overlay-snapshot.txt', await cue.snapshotText(cue.path('cue.png')));
        assertContains(snapshot, /How many hives/);
    },
);
