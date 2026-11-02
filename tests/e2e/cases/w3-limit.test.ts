import { accountProject, assertEq, assertTextContains, e2eCase, windowText } from '../harness/index.ts';

const OWNER = 'owner@cue.test';

e2eCase(
    'Cue for Windows: when the month’s allowance is spent Cue says so with an alert (once), the overlay says so plainly, no call answers anything, ' +
        'and when the owner raises the limit Cue says it has room again.',
    async (cue) => {
        const backend = await cue.backend({ adminEmails: [OWNER] });
        await accountProject(cue, 'Bees');
        await cue.launch({ CUE_PROJECT: 'Bees', CUE_ME_TICK: '1' });

        await backend.setLimit(OWNER, cue.email, 5);
        await backend.seedUsage(cue.email, [{ feature: 'answer', usd: 5 }]);
        await cue.waitLog(
            /⚠︎ Cue plan limit reached: You've used \$5\.00 of your \$5\.00 Cue plan for this month\. It starts over on \w+ \d+ \(UTC\)\./,
            60,
        );

        // Start Cue: no call answers anything, and the overlay says why where it says what Cue is doing.
        cue.control('start Bees');
        await cue.waitFor('the overlay to say the limit is reached', 60, async () =>
            /^Plan limit reached$/m.test(await windowText(cue.pid)),
        );
        assertTextContains(await windowText(cue.pid), /^Plan limit reached$/);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        assertEq(
            cue.serviceRequests('anthropic-request').filter((request) => request.kind === 'answer' && request.maxTokens > 0).length,
            0,
            'no answer is written',
        );
        assertEq(cue.logCount(/Cue plan limit reached/), 1, 'the alert is once');

        // The owner raises the limit.
        await backend.setLimit(OWNER, cue.email, 50);
        await cue.waitLog(/🔓 Cue plan has room again/, 60);
    },
);
