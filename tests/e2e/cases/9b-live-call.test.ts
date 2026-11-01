import { readFileSync } from 'node:fs';
import { assertContains, assertDeepEq, assertEq, bursts, e2eCase, fail, fixture, LiveClient, pcmOf, startCall } from '../harness/index.ts';

e2eCase(
    'A call streamed to the backend gets its live transcript, both sides apart; its question is spotted, matched to a prepared answer and answered.',
    async (cue) => {
        cue.standIns({
            FAKE_DEEPGRAM_LIVE: JSON.stringify([
                'Thank you for the talk. How many hives did you study?',
                { text: 'I studied forty eight hives.' },
                { text: 'And how long did the study run?', speaker: 1 },
            ]),
            FAKE_CLAUDE_ANSWER: 'We studied 48 hives on 6 rooftops.\n• Six rooftops across Kyiv\nSource: talk.md',
        });
        const backend = await cue.backend();
        const call = await startCall(backend, 'ann@cue.test', {
            materials: [fixture('materials', 'talk.md')],
            namesAndTerms: 'varroa mite, Kyiv',
        });
        const others = pcmOf(
            readFileSync(
                await bursts(cue.path('others.wav'), 12, [
                    [1, 3.5],
                    [8, 10],
                ]),
            ),
        );
        const me = pcmOf(readFileSync(await bursts(cue.path('me.wav'), 12, [[5, 6.5]])));

        const live = await LiveClient.connect(backend, call.token, call.callId);
        await live.next('status', (status) => status.part === 'speech' && status.state === 'ready', 30);
        await live.next('status', (status) => status.part === 'claude' && status.state === 'ready', 30);
        const judge = await live.next('status', (status) => status.part === 'judge' && status.state === 'ready', 30);
        assertEq(judge.detail, 'Claude Haiku ready');

        await Promise.all([live.play('others', others), live.play('me', me)]);
        const asked = await live.next('question', () => true, 30);
        assertEq(asked.text, 'How many hives did you study?', 'the judge found the question in the first line');
        assertEq(asked.requested, true, 'Auto is on: it is being answered');
        assertEq(asked.forced, false, 'noticed by Cue, not asked for');
        assertEq(
            asked.opener ?? undefined,
            'We studied 48 hives on 6 rooftops in Kyiv over two seasons.',
            'the prepared answer’s first sentence, until the answer comes',
        );
        const prepared = await live.next('prepared', (event) => event.questionId === asked.id, 10);
        assertEq(prepared.source, 'talk.md');
        assertEq(prepared.answer, 'We studied 48 hives on 6 rooftops in Kyiv over two seasons.');
        const done = await live.next('answer.done', (event) => event.questionId === asked.id, 30);
        assertEq(done.error ?? undefined, undefined);
        assertEq(live.answerTo(asked.id), 'We studied 48 hives on 6 rooftops.\n• Six rooftops across Kyiv\nSource: talk.md');
        await live.next('transcript.final', (line) => line.text === 'And how long did the study run?', 30);

        const lines = live.of('transcript.final');
        assertDeepEq(
            lines.map((line) => [line.channel, line.speaker, line.text]),
            [
                ['others', 1, 'Thank you for the talk. How many hives did you study?'],
                ['me', null, 'I studied forty eight hives.'],
                ['others', 2, 'And how long did the study run?'],
            ],
            'each side, in order, with the voices told apart on the call side',
        );
        if (!lines.every((line) => line.start >= 0 && line.end > line.start)) fail('every line has its times', JSON.stringify(lines));
        assertEq(
            lines[0]!.start > 0.5 && lines[0]!.start < 2.5,
            true,
            `the first line starts about a second in (it says ${lines[0]!.start})`,
        );
        if (live.of('transcript.partial').length === 0) fail('partials come before the finals');
        assertEq(
            live.of('speaking').filter((event) => event.channel === 'others' && event.active).length,
            2,
            'they were told when the call side started talking',
        );

        // What reached Claude: the question with the prompt from the project's materials; the second line (a statement of the speaker's) is not asked.
        const asks = cue.claudeRequests('ask');
        assertEq(asks.length, 1, 'only the question was sent for an answer');
        assertContains(cue.save('ask.txt', asks[0]!), /^Question: \[Participant\] How many hives did you study\?/);
        assertContains(cue.save('system.txt', cue.claudeRequests('answer-system')[0]!), /48 hives on 6 rooftops in Kyiv/);
        assertContains(cue.save('system2.txt', cue.claudeRequests('answer-system')[0]!), /# PREPARED ANSWERS/);

        const ended = await backend.call('POST', `/v1/calls/${call.callId}/end`, call.token);
        assertEq(ended.status, 200);
        assertEq(ended.body.lines, 3);
        await live.next('ended', () => true, 10);
        const [row] = await backend.rows(`SELECT ended_at, transcript FROM call WHERE id = '${call.callId}'`);
        assertEq(typeof row?.['ended_at'], 'number', 'the call is marked over');
        assertEq((JSON.parse(String(row?.['transcript'])) as unknown[]).length, 3, 'its transcript is kept');
    },
);
