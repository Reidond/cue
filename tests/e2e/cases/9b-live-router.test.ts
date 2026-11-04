import { assertEq, e2eCase, fixture, LiveClient, startCall } from '../harness/index.ts';

e2eCase(
    'Each question goes to the Claude it needs: Haiku for one a prepared answer covers or a plain fact, Sonnet for reasoning, and Sonnet for all when Haiku is down.',
    async (cue) => {
        cue.standIns({ FAKE_CLAUDE_ANSWER: 'An answer.\nSource: talk.md' });
        const backend = await cue.backend();
        const call = await startCall(backend, 'ann@cue.test', { materials: [fixture('materials', 'talk.md')], call: { auto: false } });
        const live = await LiveClient.connect(backend, call.token, call.callId);
        await live.next('status', (status) => status.part === 'claude' && status.state === 'ready', 30);
        await cue.waitFor('Haiku to be warmed too', 30, () =>
            cue
                .serviceRequests('anthropic-request')
                .some((request) => request.kind === 'answer' && request.maxTokens === 0 && request.model === 'claude-haiku-5-5'),
        );
        // Its warm-up has been answered (the stand-in answers at once), so Haiku is ready: until then Sonnet answers the quick ones too.
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        /** The model that answered a question asked in the Ask field. */
        const modelFor = async (text: string): Promise<string> => {
            const before = cue.serviceRequests('anthropic-request').length;
            live.command({ type: 'ask', text });
            const question = await live.next('question', (event) => event.text === text, 10);
            await live.next('answer.done', (event) => event.questionId === question.id, 30);
            const sent = cue
                .serviceRequests('anthropic-request')
                .slice(before)
                .filter((request) => request.kind === 'answer' && request.maxTokens > 0);
            assertEq(sent.length, 1, `one request for «${text}»`);
            return sent[0]!.model;
        };

        assertEq(await modelFor('How many hives did you study?'), 'claude-haiku-5-5', 'a prepared answer covers it');
        assertEq(await modelFor('When did the study end?'), 'claude-haiku-5-5', 'a plain fact');
        assertEq(await modelFor('Скільки меду давав один вулик?'), 'claude-haiku-5-5', 'a plain fact, in Ukrainian');
        assertEq(await modelFor('Why do rooftop colonies make more honey than suburban ones?'), 'claude-sonnet-5-5', 'reasoning');
        assertEq(await modelFor('Чому на дахах менше втрат узимку?'), 'claude-sonnet-5-5', 'reasoning, in Ukrainian');
        assertEq(
            await modelFor('If you had to pick one city for the next study, and kept the same number of hives, which one would it be?'),
            'claude-sonnet-5-5',
            'a long one',
        );
        // The two answer from one conversation: whichever answered last, the next question follows on from it.
        const last = cue
            .serviceRequests('anthropic-request')
            .filter((request) => request.kind === 'answer' && request.maxTokens > 0)
            .at(-1)!;
        assertEq(last.messages, 11, 'the five questions and answers before it, and itself');

        // Haiku down: its warm-up fails and Sonnet answers the quick questions too.
        cue.standIns({ FAKE_ANTHROPIC_MODEL_FAILS: 'claude-haiku-5-5' });
        const second = await startCall(backend, 'bob@cue.test', { materials: [fixture('materials', 'talk.md')], call: { auto: false } });
        const other = await LiveClient.connect(backend, second.token, second.callId);
        await other.next('status', (status) => status.part === 'claude' && status.state === 'ready', 30);
        const before = cue.serviceRequests('anthropic-request').length;
        other.command({ type: 'ask', text: 'How many hives did you study?' });
        const question = await other.next('question', () => true, 10);
        await other.next('answer.done', (event) => event.questionId === question.id && event.error === null, 30);
        const answered = cue
            .serviceRequests('anthropic-request')
            .slice(before)
            .filter((request) => request.kind === 'answer' && request.maxTokens > 0);
        assertEq(answered.at(-1)?.model, 'claude-sonnet-5-5', 'Sonnet stands in for Haiku');
    },
);
