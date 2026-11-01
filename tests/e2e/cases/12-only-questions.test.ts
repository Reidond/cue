import { assertContains, assertEq, assertNotContains, dialogue, e2eCase, fixture } from '../harness/index.ts';

e2eCase(
    'Only the questions the judge finds are answered: the talk gets nothing, and two asked in one go are answered each, shown together.',
    async (cue) => {
        await cue.defaults('materials', [fixture('materials', 'talk.md')]);
        await cue.defaults('language', 'en');
        await cue.defaults('autoAnswer', true);
        const call = await dialogue(fixture('dialogues', 'talk-then-two-questions.txt'), cue.path('call'));
        await cue.launch({
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            FAKE_DEEPGRAM_LIVE: call.live(),
            CUE_SNAPSHOT: cue.path('cue.png'),
            // The judge hears everything said so far each time; the first pattern that matches is its verdict.
            FAKE_CLAUDE_JUDGEMENTS: JSON.stringify({
                'two questions': 'Q: How many hives did you study?\nQ: And which rooftops did you use?',
                benefits: '—',
            }),
            FAKE_CLAUDE_ANSWERS: JSON.stringify({
                hives: 'We studied 48 hives on six rooftops.\n- Counted every spring\nSource: talk.md',
                rooftops: 'We used flat green roofs downtown.\n- Point about the roofs\nSource: talk.md',
            }),
        });
        await cue.waitLog(/Question:.*rooftops.*\(2 of 2\)/, 120);
        await cue.waitFor('both answers', 30, () => cue.logCount(/Answer\*\* \(/) >= 2);

        const log = cue.sessionLog();
        assertContains(log, /Question:\*\* How many hives did you study\? _\(1 of 2\)_/);
        assertEq(cue.logCount(/❓/), 2, 'only the two questions should be asked, not the talk');
        const asked = cue.claudeRequests('ask');
        assertEq(asked.length, 2, 'Claude should get one request per question');
        const requests = cue.save('asked.txt', asked.join('\n----\n'));
        assertContains(requests, /^Question: \[Participant\] How many hives did you study\?$/);
        assertContains(requests, /^Question: \[Participant\] And which rooftops did you use\?$/);
        assertContains(requests, /Asked in one go with «And which rooftops did you use\?»/);
        assertNotContains(requests, /^Question: .*(colonies|benefits)/);
        const judged = cue.save('judged.txt', cue.claudeRequests('judge').join('\n----\n'));
        assertContains(judged, /^\[Participant\] Who benefits from this\?/, 'the judge should hear the rhetorical question');
        assertContains(judged, /^\[Participant\] Thank you for the talk/, 'and the questions');
        const prompt = cue.save('judge-system.txt', cue.claudeRequests('judge-system').join(''));
        assertContains(prompt, /rhetorical questions/, "the judge's prompt should say what isn't a question");

        const overlay = cue.save('overlay.txt', await cue.snapshotText(cue.path('cue.png')));
        assertContains(overlay, /How many hives did you study/, 'the overlay should show the first question');
        assertContains(overlay, /which rooftops did you use/, 'and the second, in the same card');
        assertContains(overlay, /Counted every spring/, "the first question's answer should show in full");
        assertContains(overlay, /Point about the roofs/, "and the second's");
    },
);
