import { readFileSync } from 'node:fs';
import {
    assertEq,
    assertTextContains,
    assertTextNotContains,
    bursts,
    DEEPGRAM,
    e2eCase,
    fixture,
    LiveClient,
    pcmOf,
    skip,
    startCall,
} from '../harness/index.ts';

e2eCase(
    'Nobody says what language a call is in: it is heard. When the call turns to Ukrainian the client is told, questions are answered in ' +
        'Ukrainian with its labels and openers, and the project’s next call starts out in it.',
    async (cue) => {
        if (DEEPGRAM !== 'fake') skip("scripts Deepgram's replies through the stand-in");
        cue.standIns({
            FAKE_DEEPGRAM_LIVE: JSON.stringify(['Good morning everyone.', 'Дякую за доповідь. Скільки років тривало ваше дослідження?']),
        });
        const backend = await cue.backend();
        const call = await startCall(backend, 'ann@cue.test', { materials: [fixture('materials', 'talk.md')] });
        const others = pcmOf(
            readFileSync(
                await bursts(cue.path('others.wav'), 9, [
                    [1, 2.5],
                    [4, 7],
                ]),
            ),
        );

        const live = await LiveClient.connect(backend, call.token, call.callId);
        await live.next('status', (status) => status.part === 'speech' && status.state === 'ready', 30);
        await live.next('status', (status) => status.part === 'claude' && status.state === 'ready', 30);
        await live.next('status', (status) => status.part === 'judge' && status.state === 'ready', 30);
        // Both streams listen in every language: Nova-3's multilingual model.
        for (const stream of cue.serviceRequests('deepgram-live')) assertEq(stream.query['language'], 'multi');
        const system = cue.claudeRequests('answer-system')[0]!;
        assertTextContains(system, /^The conversation can be in any language\./, 'the prompt holds no language');
        assertTextNotContains(system, /Ukrainian/);

        // On connecting the client was told the language the call starts out in: the project's, not heard yet.
        const start = live.of('language')[0];
        assertEq(start?.language, 'en');
        assertEq(start?.heard, false);
        await live.play('others', others);
        const heard = await live.next('language', (event) => event.heard, 30);
        assertEq(heard.language, 'uk');
        assertEq(heard.name, 'Ukrainian');
        assertEq(
            live.of('language').filter((event) => event.heard).length,
            1,
            'the English start was the language the call already assumed: no event for it',
        );
        const asked = await live.next('question', () => true, 30);
        assertEq(asked.text, 'Скільки років тривало ваше дослідження?');
        assertEq(asked.opener ?? undefined, 'Дякую за запитання. Дозвольте коротко пояснити.', "no prepared answer: Ukrainian's opener");
        await live.next('answer.done', (event) => event.questionId === asked.id, 30);
        assertTextContains(
            cue.claudeRequests('ask').at(-1)!,
            /^\(The conversation is in Ukrainian: answer in Ukrainian, with the labels "Цифри:" and "Джерело:"\.\)$/,
            'Claude is told what to answer in',
        );

        // A client connecting afresh is told the language with the statuses.
        const again = await LiveClient.connect(backend, call.token, call.callId);
        assertEq((await again.next('language', () => true, 10)).language, 'uk');
        again.close();

        // The call keeps it for its notes, and the project for its next call.
        await backend.call('POST', `/v1/calls/${call.callId}/end`, call.token);
        await live.next('ended', () => true, 10);
        live.close();
        const [row] = await backend.rows(`SELECT language FROM call WHERE id = '${call.callId}'`);
        assertEq(String(row?.['language']), 'uk', 'the call was held in Ukrainian');
        const project = (await backend.call('GET', `/v1/projects/${call.projectId}`, call.token)).body as { language: string };
        assertEq(project.language, 'uk', 'the language the project’s calls were last heard in');

        const next = await backend.call('POST', '/v1/calls', call.token, { body: { projectId: call.projectId, speaker: 'Andrii' } });
        const second = await LiveClient.connect(backend, call.token, (next.body as { callId: string }).callId);
        await second.next('status', (status) => status.part === 'claude' && status.state === 'ready', 30);
        const starts = await second.next('language', () => true, 10);
        assertEq(`${starts.language} ${String(starts.heard)}`, 'uk false', 'it is told so at once, before anything is heard');
        second.command({ type: 'ask', text: 'How long did it take?' });
        const typed = await second.next('question', () => true, 30);
        await second.next('answer.done', (event) => event.questionId === typed.id, 30);
        assertTextContains(
            cue.claudeRequests('ask').at(-1)!,
            /^\(The conversation is in Ukrainian: answer in Ukrainian/,
            'before a word is heard',
        );
        second.close();
    },
);
