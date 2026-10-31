import { readFileSync } from 'node:fs';
import { assertEq, bursts, e2eCase, fail, fixture, LiveClient, pcmOf, startCall } from '../harness/index.ts';

e2eCase('Questions asked in the Ask field are answered at once, over the socket and as server-sent events; with Auto off, noticed ones wait for Prepare Answer.', async (cue) => {
    cue.standIns({ FAKE_CLAUDE_ANSWER: 'Because rooftops have fewer pesticides.\n• Linden flowers\nSource: talk.md' });
    const backend = await cue.backend();
    const call = await startCall(backend, 'ann@cue.test', { materials: [fixture('materials', 'talk.md')], call: { auto: false } });
    const live = await LiveClient.connect(backend, call.token, call.callId);
    await live.next('status', (status) => status.part === 'judge' && status.state === 'ready', 30);

    // The Ask field over the socket: forced (shown at once), matched to a prepared answer, answered.
    live.command({ type: 'ask', text: 'Why did you put the hives on rooftops?' });
    const forced = await live.next('question', () => true, 10);
    assertEq(forced.forced, true);
    assertEq(forced.requested, true);
    assertEq(forced.index, 0);
    assertEq(forced.of, 1);
    assertEq((await live.next('prepared', (event) => event.questionId === forced.id, 10)).source, 'talk.md');
    await live.next('answer.done', (event) => event.questionId === forced.id, 30);
    assertEq(live.answerTo(forced.id), 'Because rooftops have fewer pesticides.\n• Linden flowers\nSource: talk.md');

    // The same over HTTP: server-sent events of the same kinds.
    const response = await fetch(new URL(`/v1/calls/${call.callId}/questions`, backend.url), {
        method: 'POST',
        headers: { authorization: `Bearer ${call.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'What were the winter losses?' }),
    });
    assertEq(response.status, 200);
    assertEq(response.headers.get('content-type') ?? undefined, 'text/event-stream');
    const stream = await response.text();
    const kinds = [...stream.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
    assertEq(kinds[0], 'question');
    assertEq(kinds.includes('prepared'), true, 'with its prepared answer');
    assertEq(kinds.includes('answer.delta'), true);
    assertEq(kinds.at(-1), 'answer.done');
    assertEq(stream.includes('Because rooftops have fewer pesticides.'), true, 'the answer is in the stream');
    // …and the socket got the exchange too.
    await live.next('question', (event) => event.text === 'What were the winter losses?', 10);

    // Auto is off: a question Cue notices waits (it is not sent to Claude) until the person asks for its answer.
    const before = cue.serviceRequests('anthropic-request').filter((request) => request.kind === 'answer' && request.maxTokens > 0).length;
    cue.standIns({ FAKE_DEEPGRAM_LIVE: JSON.stringify(['Where did you keep them?']) });
    await live.play('others', pcmOf(readFileSync(await bursts(cue.path('call.wav'), 6, [[1, 3]]))));
    const waiting = await live.next('question', (event) => event.text === 'Where did you keep them?', 30);
    assertEq(waiting.requested, false, 'noticed with Auto off');
    assertEq(waiting.forced, false);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assertEq(cue.serviceRequests('anthropic-request').filter((request) => request.kind === 'answer' && request.maxTokens > 0).length, before, 'nothing is sent to Claude yet');
    live.command({ type: 'prepare', exchange: waiting.exchange });
    await live.next('answer.done', (event) => event.questionId === waiting.id, 30);
    if (live.answerTo(waiting.id) === '') fail('Prepare Answer should answer it');

    // The settings can change while the call runs: Auto on answers the next one by itself.
    live.command({ type: 'config', auto: true });
});
