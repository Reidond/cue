import { readFileSync } from 'node:fs';
import { assertEq, bursts, e2eCase, fixture, LiveClient, pcmOf, startCall } from '../harness/index.ts';

const OWNER = 'owner@cue.test';

e2eCase(
    'A call that runs into the limit stops answering and says why over the socket (a question the person asked gets the reason as its answer, ' +
        'one Cue noticed is not listed, nothing is sent to Claude); the transcript goes on; once the owner raises the limit answers flow again.',
    async (cue) => {
        cue.standIns({ FAKE_CLAUDE_ANSWER: 'Because rooftops have fewer pesticides.' });
        const backend = await cue.backend({ adminEmails: [OWNER] });
        const call = await startCall(backend, 'ann@cue.test', { materials: [fixture('materials', 'talk.md')] });
        const live = await LiveClient.connect(backend, call.token, call.callId);
        await live.next('status', (status) => status.part === 'judge' && status.state === 'ready', 30);
        const answers = () =>
            cue.serviceRequests('anthropic-request').filter((request) => request.kind === 'answer' && request.maxTokens > 0).length;

        // Within the limit: answered.
        live.command({ type: 'ask', text: 'Why did you put the hives on rooftops?' });
        const first = await live.next('question', () => true, 10);
        await live.next('answer.done', (event) => event.questionId === first.id, 30);
        assertEq(live.answerTo(first.id), 'Because rooftops have fewer pesticides.');
        assertEq(live.of('error').length, 0, 'nothing wrong yet');

        // The month's money runs out while the call goes on.
        await backend.seedUsage('ann@cue.test', [{ feature: 'answer', usd: 20 }]);
        const sent = answers();
        live.command({ type: 'ask', text: 'What were the winter losses?' });
        const second = await live.next('question', (event) => event.text === 'What were the winter losses?', 10);
        const refused = await live.next('answer.done', (event) => event.questionId === second.id, 30);
        assertEq(/of your \$20\.00 Cue plan/.test(refused.error ?? ''), true, `the answer is the reason: ${refused.error}`);
        assertEq(live.answerTo(second.id), '', 'no answer was written');
        assertEq(answers(), sent, 'nothing reached Claude');
        const error = await live.next('error', (event) => event.code === 'limit_reached', 10);
        assertEq(error.fatal, false, 'the call is not over');
        assertEq(error.message, refused.error ?? '');

        // Questions Cue notices on its own are not even listed, but what is said is still transcribed.
        cue.standIns({ FAKE_DEEPGRAM_LIVE: JSON.stringify(['Where did you keep them?']) });
        await live.play('others', pcmOf(readFileSync(await bursts(cue.path('call.wav'), 6, [[1, 3]]))));
        await live.next('transcript.final', (event) => event.text === 'Where did you keep them?', 30);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        assertEq(live.of('question').some((event) => event.text === 'Where did you keep them?'), false, 'not listed');
        assertEq(answers(), sent, 'still nothing sent to Claude');

        // Someone who connects now hears of the limit at once.
        const late = await LiveClient.connect(backend, call.token, call.callId);
        await late.next('error', (event) => event.code === 'limit_reached', 10);
        late.close();

        // The owner raises the limit: the next question is answered.
        await backend.setLimit(OWNER, 'ann@cue.test', 100);
        live.command({ type: 'ask', text: 'And the losses in the summer?' });
        const third = await live.next('question', (event) => event.text === 'And the losses in the summer?', 10);
        const done = await live.next('answer.done', (event) => event.questionId === third.id, 30);
        assertEq(done.error === null, true, String(done.error));
        assertEq(live.answerTo(third.id), 'Because rooftops have fewer pesticides.', 'answers flow again');
        live.close();
    },
);
