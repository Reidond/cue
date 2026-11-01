import { AdminPage, assertEq, e2eCase } from '../harness/index.ts';

const day = (date: Date) => date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

e2eCase(
    "The overview shows the month's seeded spend against the limits: per day, top users and features; other months are their own.",
    async (cue) => {
        const owner = 'owner@cue.test';
        const [ann, ben] = ['ann@cue.test', 'ben@cue.test'];
        const backend = await cue.backend({ adminEmails: [owner] });
        for (const email of [ann!, ben!]) {
            await backend.invite(email);
            await backend.tokensFor(email);
        }

        // Days 1 and 2 of this UTC month (always in the month), and one row in the month before.
        const now = new Date();
        const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 10));
        const second = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 2, 10));
        const before = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15, 10));
        await backend.seedUsage(ann!, [
            { feature: 'answer', usd: 1.5, at: first },
            { feature: 'question_judge', usd: 0.25, at: first },
            { feature: 'answer', usd: 9.99, at: before, provider: 'anthropic' },
        ]);
        await backend.seedUsage(ben!, [
            { feature: 'live_transcript', provider: 'deepgram', unit: 'audio_seconds', units: 600, usd: 2, at: second },
            { feature: 'answer', usd: 0.75, at: second },
        ]);

        for (const scheme of ['light', 'dark'] as const) {
            const admin = await AdminPage.signIn(backend, owner, { scheme, shots: cue.path('shots') });
            const { page } = admin;
            await admin.waitForShell();

            // $4.50 spent of 3 × $20 in limits (the owner has the default too).
            await page.getByText('$4.50', { exact: true }).first().waitFor();
            await page.getByText('8% of the limits').waitFor();
            await page.getByText('$60.00 across 3 people').waitFor();

            const topUsers = page.getByRole('region', { name: 'Top users' });
            const names = await topUsers.locator('.rows').getByRole('link').allInnerTexts();
            assertEq(names.join(','), 'ben,ann', `top users, the biggest spender first (Ben $2.75, Ann $1.75), got ${names.join(',')}`);
            await topUsers.getByText('$2.75').waitFor();
            await topUsers.getByText('$1.75').waitFor();

            const features = page.getByRole('region', { name: 'By feature' });
            await features.getByText('Answer').waitFor();
            await features.getByText('$2.25').waitFor();
            await features.getByText('Live transcript').waitFor();
            await features.getByText('Question judge').waitFor();

            // The chart reads day by day with the arrow keys.
            const chart = page.getByRole('slider', { name: /Spend per day/ });
            await chart.focus();
            await page.keyboard.press('Home');
            assertEq((await chart.getAttribute('aria-valuetext')) ?? undefined, `${day(first)}: $1.75`);
            await page.keyboard.press('ArrowRight');
            assertEq((await chart.getAttribute('aria-valuetext')) ?? undefined, `${day(second)}: $2.75`);

            // The month before is its own report.
            await page.getByRole('link', { name: 'Previous month' }).click();
            await page.getByText('$9.99', { exact: true }).first().waitFor();
            await page.getByText('$4.50', { exact: true }).waitFor({ state: 'detached' });
            admin.assertClean();
            await page.getByRole('link', { name: 'Next month' }).click();
            await page.getByText('$4.50', { exact: true }).first().waitFor();
            await admin.shot('overview');
            await admin.close();
        }
    },
);
