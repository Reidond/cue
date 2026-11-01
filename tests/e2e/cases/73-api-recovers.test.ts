import { assertEq, e2eCase } from '../harness/index.ts';

e2eCase(
    'When Claude fails for a passing reason (overload, the network) as a call starts, the question judge says so, goes by ' +
        'question marks meanwhile, and is ready again once Claude answers.',
    async (cue) => {
        await cue.project('Bees', { language: 'en' });
        // Three tries at the start (the backend's first and two more, a second and two apart), all overloaded.
        await cue.launch({ CUE_PROJECT: 'Bees', FAKE_ANTHROPIC_OVERLOADED: '3' });
        cue.control('start Bees');
        await cue.waitLog(/⚠︎ Question judge unavailable \(Claude is overloaded\. Try again in a moment\.\) — going by question marks/, 30);
        await cue.waitLog(/🧐 Question judge ready: Claude Haiku/, 40);
        const warmups = cue.serviceRequests('anthropic-request').filter((request) => request.kind === 'judge' && request.maxTokens === 0);
        assertEq(warmups.length, 4, 'three overloaded tries, then the one 15 s later that got through');
    },
);
