import { readFileSync } from 'node:fs';
import { assertEq, bursts, DEEPGRAM, e2eCase, LiveClient, pcmOf, skip, sleep, startCall } from '../harness/index.ts';

e2eCase(
    "A call follows the account's settings — the speaker's name, Auto — once the account has them, a change reaching a call under way; until " +
        'then it goes by what an app from before them sends, and after that what such an app sends changes nothing.',
    async (cue) => {
        if (DEEPGRAM !== 'fake') skip("scripts Deepgram's replies through the stand-in");
        cue.standIns({
            FAKE_DEEPGRAM_LIVE: JSON.stringify([
                'How many hives did you study?',
                'How long did the study run?',
                'Where were the rooftops?',
            ]),
            FAKE_CLAUDE_ANSWER: 'We studied 48 hives.',
        });
        const backend = await cue.backend();
        // The prompts Claude was given for answering, by the name they say the speaker goes by: each is written once before the first question,
        // for each of the two models that answer (Claude Sonnet and Claude Haiku), so a call's prompt counts as one when both have it.
        const prompts = (name: string) =>
            cue.claudeRequests('answer-system').filter((system) => system.startsWith(`You are a live prompter for ${name}.`)).length / 2;

        // An app from before the account kept settings sends its own with every call; the account has none, so the call goes by them.
        const call = await startCall(backend, 'ann@cue.test', { call: { speaker: 'Old App Name', auto: true } });
        const patch = async (body: unknown) => {
            const changed = await backend.call('PATCH', '/v1/me/settings', call.token, { body });
            assertEq(changed.status, 200, JSON.stringify(changed.body));
        };
        await cue.waitFor("Claude's prompt to name the speaker as the app said", 30, () => prompts('Old App Name') === 1);

        // The account gets a name of its own (a new app signed in, or Settings changed it on any device): the call under way follows it.
        await patch({ speakerName: 'Ann Tester', autoAnswer: false });
        await cue.waitFor("the call under way to name the account's speaker", 30, () => prompts('Ann Tester') === 1);

        // A new call goes by the account, whatever the app sends.
        const second = await backend.call('POST', '/v1/calls', call.token, {
            body: { projectId: call.projectId, speaker: 'Old App Name', auto: true },
        });
        assertEq(second.status, 201);
        await cue.waitFor("the new call's prompt to name the account's speaker", 30, () => prompts('Ann Tester') === 2);
        await backend.call('POST', `/v1/calls/${second.body.callId}/end`, call.token);

        // Auto is the account's too: off there, a question waits for Prepare Answer though the app asked for Auto.
        const live = await LiveClient.connect(backend, call.token, call.callId);
        await live.next('status', (status) => status.part === 'speech' && status.state === 'ready', 30);
        await live.next('status', (status) => status.part === 'judge' && status.state === 'ready', 30);
        const question = async (text: string) => {
            await live.play('others', pcmOf(readFileSync(await bursts(cue.path(`${live.of('question').length}.wav`), 6, [[0.5, 2.5]]))));
            return live.next('question', (event) => event.text === text, 30);
        };
        assertEq((await question('How many hives did you study?')).requested, false, "Auto is off in the account: it isn't answered");

        // What the app sends while the call runs changes nothing the account has: not Auto, not the name.
        live.command({ type: 'config', speaker: 'Old App Name', auto: true });
        await sleep(2);
        assertEq((await question('How long did the study run?')).requested, false, "the app's Auto doesn't count");
        assertEq(prompts('Old App Name'), 1, "the app's name doesn't count");

        // Auto turned on in the account (on any device) reaches the call at once.
        await patch({ autoAnswer: true });
        const answered = await question('Where were the rooftops?');
        assertEq(answered.requested, true, 'Auto is on in the account: it is being answered');
        await live.next('answer.done', (event) => event.questionId === answered.id, 30);
        live.drop();
    },
);
