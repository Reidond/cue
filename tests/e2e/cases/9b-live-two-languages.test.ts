import { readFileSync } from 'node:fs';
import { assertEq, assertTextContains, bursts, DEEPGRAM, e2eCase, fixture, LiveClient, pcmOf, skip, startCall } from '../harness/index.ts';

e2eCase(
    'A person who reads Cue in two languages gets every question and answer in both: the answer in the language spoken, each line followed by ' +
        'its translation, and the question translated; with one language again, only the one.',
    async (cue) => {
        if (DEEPGRAM !== 'fake') skip("scripts Deepgram's replies through the stand-in");
        cue.standIns({
            FAKE_DEEPGRAM_LIVE: JSON.stringify([
                'Thank you for the talk. How many hives did you study?',
                'And how long did the study run?',
            ]),
            FAKE_CLAUDE_ANSWER:
                'We studied 48 hives on 6 rooftops.\n» Ми дослідили 48 вуликів на 6 дахах.\n• Two seasons in Kyiv\n» • Два сезони в Києві',
            FAKE_CLAUDE_TRANSLATIONS: JSON.stringify({ 'How many hives did you study?': 'Скільки вуликів ви дослідили?' }),
        });
        const backend = await cue.backend();
        const call = await startCall(backend, 'ann@cue.test', { materials: [fixture('materials', 'talk.md')] });

        // The languages are the account's: two at most, from the list, each once.
        const put = (languages: string[]) => backend.call('PUT', '/v1/me/languages', call.token, { body: { languages } });
        assertEq((await put(['en', 'uk', 'pl'])).status, 400, 'three languages');
        assertEq((await put(['en', 'en'])).status, 400, 'the same one twice');
        assertEq((await put(['en', 'xx'])).status, 400, 'one Cue does not know');
        assertEq((await put(['en', 'uk'])).status, 200);
        assertEq(((await backend.call('GET', '/v1/me', call.token)).body as { languages: string[] }).languages.join(), 'en,uk');

        // A call made now reads them.
        const started = await backend.call('POST', '/v1/calls', call.token, { body: { projectId: call.projectId, speaker: 'Andrii' } });
        const live = await LiveClient.connect(backend, call.token, (started.body as { callId: string }).callId);
        await live.next('status', (status) => status.part === 'speech' && status.state === 'ready', 30);
        await live.next('status', (status) => status.part === 'judge' && status.state === 'ready', 30);
        const speech = pcmOf(readFileSync(await bursts(cue.path('others.wav'), 5, [[1, 3.5]])));
        await live.play('others', speech);
        const asked = await live.next('question', () => true, 30);
        assertEq(asked.text, 'How many hives did you study?');
        assertEq(
            JSON.stringify(asked.translation),
            JSON.stringify({ language: 'uk', name: 'Ukrainian', text: 'Скільки вуликів ви дослідили?' }),
        );
        await live.next('answer.done', (event) => event.questionId === asked.id, 30);
        assertEq(
            live
                .answerTo(asked.id)
                .split('\n')
                .filter((line) => line.startsWith('» ')).length,
            2,
            'each line followed by its translation',
        );
        assertTextContains(
            cue.claudeRequests('ask').at(-1)!,
            /^\(After each line of the answer, write it in Ukrainian on a line of its own that starts with "» "/,
            'Claude is asked for the translation lines',
        );
        assertTextContains(cue.claudeRequests('judge').at(-1)!, /the question in Ukrainian\.\)$/, 'and the judge for the question’s');

        // Back to one language, told in the call's settings: the next question is in that one alone.
        live.command({ type: 'config', languages: ['en'] });
        await live.play('others', speech);
        const next = await live.next('question', (event) => event.id !== asked.id, 30);
        assertEq(next.translation === null, true, 'one language: no translation');
        await live.next('answer.done', (event) => event.questionId === next.id, 30);
        if (/write it in Ukrainian/.test(cue.claudeRequests('ask').at(-1)!))
            throw new Error('no translation is asked for with one language');
        live.close();
    },
);
