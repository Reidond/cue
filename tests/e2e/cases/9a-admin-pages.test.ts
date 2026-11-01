import { AdminPage, assertEq, e2eCase } from '../harness/index.ts';

e2eCase(
    'Every admin page draws in light and dark, wide and narrow, without errors, scrolling sideways or an empty state in the way.',
    async (cue) => {
        const owner = 'owner@cue.test';
        const backend = await cue.backend({ adminEmails: [owner] });
        // Before anyone has signed in or spent anything: the sign-in, and the pages with nothing to show say what comes next.
        for (const scheme of ['light', 'dark'] as const) {
            const signedOut = await AdminPage.open(backend, { scheme, shots: cue.path('shots') });
            await signedOut.page.getByRole('link', { name: 'Continue with GitHub' }).waitFor();
            await signedOut.shot('empty-0-sign-in');
            await signedOut.close();

            const bare = await AdminPage.signIn(backend, owner, { scheme, shots: cue.path('shots') });
            await bare.waitForShell();
            await bare.page.getByText('No usage yet').waitFor();
            await bare.shot('empty-1-overview');
            await bare.navigate('Invites');
            await bare.page.getByText('No one is waiting.').waitFor();
            await bare.shot('empty-2-invites');
            bare.assertClean();
            await bare.close();
        }

        const people = ['ada@cue.test', 'grace@cue.test', 'linus@cue.test', 'margaret@cue.test'];
        for (const email of people) {
            await backend.invite(email);
            await backend.tokensFor(email);
        }
        await backend.invite('pending@cue.test');
        await backend.disable('linus@cue.test');

        const now = new Date();
        const at = (day: number) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), day, 12));
        const features = ['answer', 'question_judge', 'live_transcript', 'notes_transcript', 'notes_summary'];
        const spend = [18.4, 7.2, 21.6, 2.1];
        for (const [index, email] of people.entries()) {
            await backend.seedUsage(
                email,
                Array.from({ length: 12 }, (_, day) => ({
                    feature: features[(day + index) % features.length]!,
                    usd: (spend[index]! / 12) * (0.4 + ((day * 7 + index * 3) % 10) / 8),
                    at: at(day + 1),
                })),
            );
        }

        const tour = async (admin: AdminPage, label: string) => {
            const { page } = admin;
            await admin.waitForShell();
            const overflow = async (where: string) => {
                const wider = (await page.evaluate(
                    `[...document.querySelectorAll('body *')].filter((el) => el.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !el.closest('.table-wrap, .nav')).slice(0, 6).map((el) => el.tagName.toLowerCase() + '.' + el.className)`,
                )) as string[];
                assertEq(
                    (await page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth')) === true,
                    true,
                    `${label}: ${where} scrolls sideways (${wider.join(', ')})`,
                );
            };

            await page.getByText('spent in').waitFor();
            await page.getByRole('region', { name: 'Top users' }).locator('.rows li').first().waitFor();
            await overflow('the overview');
            await page.getByRole('slider', { name: /Spend per day/ }).focus();
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('ArrowRight');
            await admin.shot(`${label}-1-overview`);

            await admin.navigate('Users');
            await page.getByRole('link', { name: 'grace', exact: true }).waitFor();
            await overflow('users');
            await admin.shot(`${label}-2-users`);

            await page.getByRole('link', { name: 'ada', exact: true }).click();
            await page.getByRole('heading', { name: 'ada' }).waitFor();
            await page.getByRole('heading', { name: 'Per day' }).waitFor();
            await overflow('a user');
            await admin.shot(`${label}-3-user`);

            await page.getByRole('button', { name: 'Disable' }).click();
            await page.getByRole('alertdialog').waitFor();
            await admin.shot(`${label}-4-confirm`);
            await page.getByRole('button', { name: 'Cancel' }).click();

            await admin.navigate('Invites');
            await page.getByText('pending@cue.test').waitFor();
            await overflow('invites');
            await admin.shot(`${label}-5-invites`);

            await admin.navigate('Settings');
            await page.getByText('Default monthly limit').first().waitFor();
            await overflow('settings');
            await admin.shot(`${label}-6-settings`);
            admin.assertClean();
        };

        for (const scheme of ['light', 'dark'] as const) {
            const wide = await AdminPage.signIn(backend, owner, { scheme, shots: cue.path('shots') });
            await tour(wide, `wide`);
            await wide.close();
        }
        const narrow = await AdminPage.signIn(backend, owner, {
            scheme: 'light',
            viewport: { width: 390, height: 844 },
            shots: cue.path('shots'),
        });
        await tour(narrow, 'narrow');
        await narrow.close();
    },
);
