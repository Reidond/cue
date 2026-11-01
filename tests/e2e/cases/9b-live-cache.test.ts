import { readFileSync } from 'node:fs';
import { assertEq, bursts, e2eCase, fail, fixture, LiveClient, pcmOf, startCall } from '../harness/index.ts';

e2eCase(
    "The prompt cache is written before the first question and kept warm while the call is quiet, for Claude's answers and for the judge alike.",
    async (cue) => {
        cue.standIns({ FAKE_DEEPGRAM_LIVE: JSON.stringify(['How many hives did you study?']), FAKE_CLAUDE_ANSWER: 'We studied 48 hives.' });
        // The caches live an hour; here the call looks every second and warms any that has been quiet for two.
        const backend = await cue.backend({ env: { CACHE_TICK_SECONDS: '1', CACHE_REFRESH_SECONDS: '2' } });
        const call = await startCall(backend, 'ann@cue.test', { materials: [fixture('materials', 'talk.md')] });
        const live = await LiveClient.connect(backend, call.token, call.callId);
        await live.next('status', (status) => status.part === 'claude' && status.state === 'ready', 30);
        await live.next('status', (status) => status.part === 'judge' && status.state === 'ready', 30);

        // Written before any question: a request that asks for no answer (max_tokens 0), with the system prompt marked for an hour's caching.
        const early = cue.serviceRequests('anthropic-request');
        const warmups = (kind: string) => early.filter((request) => request.kind === kind && request.maxTokens === 0);
        assertEq(warmups('answer').length, 1, 'the answer prompt is written to the cache first');
        assertEq(warmups('judge').length, 1, "and the judge's");
        assertEq(JSON.stringify(warmups('answer')[0]?.systemCache), JSON.stringify({ type: 'ephemeral', ttl: '1h' }), 'for an hour');
        assertEq(JSON.stringify(warmups('answer')[0]?.cache), undefined, 'the warm-up has no conversation to cache');
        assertEq(early.filter((request) => request.maxTokens > 0).length, 0, 'no question had been asked yet');

        // Quiet: it is warmed again, and again (a request in each tick that finds it two seconds old).
        await cue.waitFor('the caches to be warmed again while the call is quiet', 30, () => {
            const requests = cue.serviceRequests('anthropic-request');
            return (
                requests.filter((request) => request.kind === 'answer' && request.maxTokens === 0).length >= 3 &&
                requests.filter((request) => request.kind === 'judge' && request.maxTokens === 0).length >= 3
            );
        });

        // A question reads the cache the warm-ups wrote, and caches the conversation too.
        const speech = pcmOf(readFileSync(await bursts(cue.path('call.wav'), 6, [[1, 3]])));
        await live.play('others', speech);
        const asked = await live.next('question', () => true, 30);
        await live.next('answer.done', (event) => event.questionId === asked.id, 30);
        const question =
            cue.serviceRequests('anthropic-request').find((request) => request.kind === 'answer' && request.maxTokens > 0) ??
            fail('the question should reach Claude');
        assertEq(question.stream, true, 'the answer streams');
        assertEq(question.model, 'claude-sonnet-5-5');
        assertEq(JSON.stringify(question.systemCache), JSON.stringify({ type: 'ephemeral', ttl: '1h' }));
        assertEq(
            JSON.stringify(question.cache),
            JSON.stringify({ type: 'ephemeral', ttl: '1h' }),
            'the conversation up to it is cached too',
        );
        const judged =
            cue.serviceRequests('anthropic-request').find((request) => request.kind === 'judge' && request.maxTokens > 0) ??
            fail('the judge should be asked');
        assertEq(judged.model, 'claude-haiku-5-5');
        assertEq(judged.stream, false);

        // Usage: what the call spent, per model, once it is over.
        await backend.call('POST', `/v1/calls/${call.callId}/end`, call.token);
        const rows = await backend.rows(
            'SELECT feature, provider, model, unit, units, cost_micros FROM usage ORDER BY feature, model, unit',
        );
        const sum = (feature: string, unit: string) =>
            rows
                .filter((row) => row['feature'] === feature && row['unit'] === unit)
                .reduce((total, row) => total + Number(row['units']), 0);
        if (sum('answer', 'cache_write_tokens') <= 0) fail('the answer prompt written to the cache is recorded', JSON.stringify(rows));
        if (sum('answer', 'cache_read_tokens') <= 0) fail('and what the warm-ups and the question read from it', JSON.stringify(rows));
        if (sum('answer', 'output_tokens') <= 0) fail('and the answer’s own tokens', JSON.stringify(rows));
        if (sum('question_judge', 'input_tokens') <= 0) fail("the judge's tokens are recorded", JSON.stringify(rows));
        if (sum('live_transcript', 'audio_seconds') < 5) fail('audio seconds are recorded, both sides', JSON.stringify(rows));
        assertEq(
            rows.some((row) => row['model'] === 'claude-haiku-5-5') &&
                rows.some((row) => row['model'] === 'claude-sonnet-5-5') &&
                rows.some((row) => row['provider'] === 'deepgram'),
            true,
            'tokens per model, and the speech provider',
        );
    },
);
