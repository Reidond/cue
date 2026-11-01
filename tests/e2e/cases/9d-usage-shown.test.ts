import { readFileSync } from 'node:fs';
import { assertBetween, assertEq, bursts, e2eCase, fixture, LiveClient, pcmOf, startCall } from '../harness/index.ts';

interface Me {
    limits: { monthlyUsd: number };
    usage: {
        month: string;
        usd: number;
        audioSeconds: number;
        limitReached: boolean;
        byFeature: { feature: string; usd: number }[];
        periodStart: number;
        periodEnd: number;
    };
}

e2eCase(
    '/v1/me reports what a call cost this month, priced by the table: the spend, the limit, the spend by feature, and the period it counts in.',
    async (cue) => {
        cue.standIns({
            FAKE_CLAUDE_ANSWER: 'Because rooftops have fewer pesticides.',
            FAKE_DEEPGRAM_LIVE: JSON.stringify(['Where did you keep them?']),
        });
        const backend = await cue.backend();
        const call = await startCall(backend, 'ann@cue.test', { materials: [fixture('materials', 'talk.md')] });
        const me = async () => (await backend.call('GET', '/v1/me', call.token)).body as Me;

        const before = await me();
        assertEq(before.usage.usd, 0, 'a new account has used nothing');
        assertEq(before.usage.limitReached, false);
        assertEq(before.limits.monthlyUsd, 20, 'the default limit');
        assertEq(before.usage.byFeature.length, 0);

        // A call with speech on the call side and a question asked: audio seconds and tokens, both priced.
        const live = await LiveClient.connect(backend, call.token, call.callId);
        await live.next('status', (status) => status.part === 'judge' && status.state === 'ready', 30);
        await live.play('others', pcmOf(readFileSync(await bursts(cue.path('call.wav'), 6, [[1, 3]]))));
        live.command({ type: 'ask', text: 'Why did you put the hives on rooftops?' });
        const question = await live.next('question', () => true, 10);
        await live.next('answer.done', (event) => event.questionId === question.id, 30);
        const ended = await backend.call('POST', `/v1/calls/${call.callId}/end`, call.token);
        assertEq(ended.status, 200);

        const after = await me();
        assertEq(after.usage.usd > 0, true, JSON.stringify(after.usage));
        assertEq(after.usage.limitReached, false);
        const features = after.usage.byFeature.map((row) => row.feature);
        for (const feature of ['answer', 'live_transcript'])
            assertEq(features.includes(feature), true, `${feature} in ${JSON.stringify(features)}`);
        assertEq(
            after.usage.byFeature.every((row, index, rows) => index === 0 || rows[index - 1]!.usd >= row.usd),
            true,
            'dearest first',
        );
        assertBetween(
            after.usage.byFeature.reduce((sum, row) => sum + row.usd, 0),
            after.usage.usd - 1e-6,
            after.usage.usd + 1e-6,
            'the features add up to the spend',
        );
        assertBetween(after.usage.audioSeconds, 5, 7, 'the call side was streamed for about 6 s');

        // The period is the UTC month the usage is counted in, both ends in milliseconds.
        const now = new Date();
        assertEq(after.usage.month, now.toISOString().slice(0, 7));
        assertEq(after.usage.periodStart, Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
        assertEq(after.usage.periodEnd, Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

        // Speech is priced by the table: Deepgram's live rate, 0.0077 USD a minute.
        const [speech] = await backend.rows(
            "SELECT SUM(units) AS seconds, SUM(cost_micros) AS micros FROM usage WHERE feature = 'live_transcript'",
        );
        const expected = (Number(speech?.['seconds']) * 7700) / 60;
        assertBetween(Number(speech?.['micros']), expected - 2, expected + 2, 'priced at the live rate');
    },
);
