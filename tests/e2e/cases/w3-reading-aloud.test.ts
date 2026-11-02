import { accountProject, assertTextContains, assertTextNotContains, bursts, e2eCase, fixture, windowText } from '../harness/index.ts';

/** Whether a line of the window's text matches (as the harness' assertions read it). */
const hasLine = (text: string, pattern: RegExp) => text.split('\n').some((line) => pattern.test(line));

e2eCase(
    'Cue for Windows: the answer in view stays while you read it aloud: a question asked meanwhile waits in the New group under it, and its answer ' +
        'comes into view once you pause, the one you read moving to Answered.',
    async (cue) => {
        await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        // The call asks the first question; you read its answer aloud (your microphone), the call asks another in a breath you take, and you read on.
        const call = await bursts(cue.path('call.wav'), 26, [
            [1, 3],
            [10, 12],
        ]);
        // You read for a while. The pause that makes the waiting answer show comes 5 s after you stop, and the window is read through UI Automation, which
        // takes a second or two and, on a slow machine under load, can come back short: so the case has time for several reads before the pause.
        const me = await bursts(cue.path('me.wav'), 26, [[7, 22]]);
        await cue.launch({
            CUE_PROJECT: 'Bees',
            CUE_REHEARSE_PARTICIPANT: call,
            CUE_REHEARSE_ME: me,
            FAKE_DEEPGRAM_LIVE: JSON.stringify([
                'How many hives did you study?',
                'We studied forty eight hives on six rooftops in the city, over two summers, and counted the bees every week.',
                'Which rooftops?',
            ]),
            FAKE_CLAUDE_ANSWERS: JSON.stringify({
                hives: 'We studied 48 hives.\n- Point about hives\nSource: talk.md',
                rooftops: 'We used six rooftops.\n- Point about roofs\nSource: talk.md',
            }),
        });
        await cue.waitLog(/Question:.*hives/, 90);

        // You're reading the first answer when the second question comes: it waits. (Read until the window says so: one read can be short or late.)
        await cue.waitLog(/📖 Waits while you read the answer in view: .*rooftops/, 60);
        let reading = '';
        await cue.waitFor('the window to show the new question waiting under the answer being read', 30, async () => {
            reading = await windowText(cue.pid);
            // The pause came first: the assertions below say what is wrong.
            return /Point about roofs/.test(reading) || (hasLine(reading, /^New$/) && hasLine(reading, /Which rooftops/));
        });
        cue.save('reading.txt', reading);
        assertTextContains(reading, /Point about hives/, 'the answer being read aloud should stay in view');
        assertTextNotContains(reading, /Point about roofs/, 'the new answer should not take its place');
        assertTextContains(reading, /^New$/, 'the new question should wait in the New group');
        assertTextContains(reading, /Which rooftops/, 'as a row under the answer being read');

        // You pause: the waiting answer comes into view by itself.
        await cue.waitLog(/📖 Shown now that you've paused: .*rooftops/, 40);
        let shown = '';
        await cue.waitFor('the second answer to show, the first one moved to Answered', 30, async () => {
            shown = await windowText(cue.pid);
            return hasLine(shown, /Point about roofs/) && hasLine(shown, /^Answered$/) && hasLine(shown, /How many hives/);
        });
        cue.save('shown.txt', shown);
        assertTextContains(shown, /^Answered$/, 'the answer read aloud has moved to Answered');
        assertTextContains(shown, /How many hives/, 'as a row there');
        assertTextNotContains(shown, /^New$/, 'nothing new is left');
    },
);
