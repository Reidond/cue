import { assertEq, assertTextContains, e2eCase, literal, print, windowText } from '../harness/index.ts';

const OWNER = 'owner@cue.test';

e2eCase(
    'Cue for Windows: Settings › Account shows who is signed in and this month’s usage against the limit; when it is spent Cue says so with an alert ' +
        '(once); when the owner raises the limit Cue says it has room again.',
    async (cue) => {
        const backend = await cue.backend({ adminEmails: [OWNER] });
        await cue.launch({ CUE_ME_TICK: '1' });
        // What the window shows, as UI Automation reads it.
        const shows = async (pattern: RegExp): Promise<boolean> => pattern.test(await windowText(cue.pid));

        // 2.50 USD of 10: the bar, the amounts, and where the money went.
        await backend.setLimit(OWNER, cue.email, 10);
        await backend.seedUsage(cue.email, [{ feature: 'answer', usd: 2.5 }]);
        cue.control('settings account');
        await cue
            .waitFor('the Account tab to show the usage', 60, () => shows(/\$2\.50 of \$10\.00/))
            .catch(async (error: unknown) => {
                print('--- the window shows', await windowText(cue.pid));
                throw error;
            });
        const account = await windowText(cue.pid);
        assertTextContains(account, new RegExp(`^${literal(cue.email)}$`, 'm'));
        for (const text of ['Signed in as', 'Used this month', 'Monthly limit', 'Starts over', 'Where it went', 'Answers', 'Sign Out']) {
            assertTextContains(account, new RegExp(`^${literal(text)}$`, 'm'), `${text} is on the page`);
        }
        assertEq(cue.logCount(/Cue plan limit reached/), 0, 'no alert while there is room');

        // The month's money runs out: an alert, once.
        await backend.seedUsage(cue.email, [{ feature: 'answer', usd: 7.5 }]);
        await cue.waitLog(
            /⚠︎ Cue plan limit reached: You've used \$10\.00 of your \$10\.00 Cue plan for this month\. It starts over on \w+ \d+ \(UTC\)\./,
            60,
        );
        await cue.waitFor('the dashboard to say so', 30, () => shows(/Cue plan limit reached/));
        assertEq(cue.logCount(/Cue plan limit reached/), 1, 'the alert is once');

        // The owner raises the limit.
        await backend.setLimit(OWNER, cue.email, 50);
        await cue.waitLog(/🔓 Cue plan has room again/, 60);
        await cue.waitFor('the dashboard to be rid of the notice', 30, async () => !(await shows(/Cue plan limit reached/)));
    },
);
