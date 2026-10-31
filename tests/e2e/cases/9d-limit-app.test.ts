import { assertContains, assertEq, e2eCase, needWindowSnapshots } from '../harness/index.ts';

const OWNER = 'owner@cue.test';

e2eCase(
    'Settings › Account shows this month’s usage against the limit; when it is spent Cue says so with an alert (once), starts no call, and answers ' +
        'nothing; when the owner raises the limit Cue says it has room again.',
    async (cue) => {
        needWindowSnapshots();
        const backend = await cue.backend({ adminEmails: [OWNER] });
        await cue.project('Bees', { language: 'en' });
        await cue.launch({ CUE_PROJECT: 'Bees', CUE_ME_TICK: '1', CUE_SNAPSHOT: cue.path('cue.png') });

        // 2.50 USD of 10: the bar, the amounts, and where the money went.
        await backend.setLimit(OWNER, cue.email, 10);
        await backend.seedUsage(cue.email, [{ feature: 'answer', usd: 2.5 }]);
        cue.control('settings account');
        let shown = '';
        await cue.waitFor('the Account tab to show the usage', 60, async () => {
            shown = await cue.snapshotText(cue.path('cue-settings.png'));
            return /\$2\.50/.test(shown) && /\$10\.00/.test(shown);
        });
        const account = cue.save('account.txt', shown);
        assertContains(account, /Used this month/);
        assertContains(account, /Monthly limit/);
        assertContains(account, /Starts over/);
        assertEq(cue.logCount(/Cue plan limit reached/), 0, 'no alert while there is room');

        // The month's money runs out: an alert, once.
        await backend.seedUsage(cue.email, [{ feature: 'answer', usd: 7.5 }]);
        await cue.waitLog(
            /⚠︎ Cue plan limit reached: You've used \$10\.00 of your \$10\.00 Cue plan for this month\. It starts over on \w+ \d+ \(UTC\)\./,
            60,
        );

        // Start Cue: no call is made, so nothing is answered.
        cue.control('start Bees');
        await new Promise((resolve) => setTimeout(resolve, 4000));
        assertEq(
            cue.serviceRequests('anthropic-request').filter((request) => request.kind === 'answer' && request.maxTokens > 0).length,
            0,
        );
        assertEq(cue.logCount(/Cue plan limit reached/), 1, 'the alert is once');

        // The owner raises the limit.
        await backend.setLimit(OWNER, cue.email, 50);
        await cue.waitLog(/🔓 Cue plan has room again/, 60);
    },
);
