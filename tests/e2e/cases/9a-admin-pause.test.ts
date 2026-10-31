import { AdminPage, assertEq, e2eCase } from '../harness/index.ts';

interface Failure {
    error: { code: string; retryable: boolean };
}

e2eCase(
    'Pausing the plan in the admin makes /v1 answer plan_paused (the admin keeps working); the other settings are saved.',
    async (cue) => {
        const owner = 'owner@cue.test';
        const person = 'person@cue.test';
        const backend = await cue.backend({ adminEmails: [owner] });
        await backend.invite(person);
        const tokens = await backend.tokensFor(person);
        assertEq((await backend.get('/v1/me', tokens.access_token)).status, 200, 'before pausing');

        const admin = await AdminPage.signIn(backend, owner, { shots: cue.path('shots') });
        const { page } = admin;
        await admin.waitForShell();
        await admin.navigate('Settings');

        // The default limit and the audio retention (30 days unless changed) are saved.
        const retention = page.getByLabel('Keep recordings for', { exact: true });
        assertEq(await retention.inputValue(), '30', 'the default audio retention');
        await retention.fill('45');
        await retention.press('Tab');
        await page.locator('form.setting', { hasText: 'Keep recordings for' }).getByRole('button', { name: 'Save' }).click();
        const limit = page.getByLabel('Default monthly limit', { exact: true });
        await limit.fill('30');
        await limit.press('Tab');
        await page.locator('form.setting', { hasText: 'Default monthly limit' }).getByRole('button', { name: 'Save' }).click();
        const monthlyUsd = async () =>
            ((await (await backend.get('/v1/me', tokens.access_token)).json()) as { limits: { monthlyUsd: number } }).limits.monthlyUsd;
        await cue.waitFor('the new default limit', 15, async () => (await monthlyUsd()) === 30);
        await cue.waitFor('the new retention', 15, async () => {
            await page.reload();
            return (await page.getByLabel('Keep recordings for', { exact: true }).inputValue()) === '45';
        });
        assertEq(await page.getByLabel('Keep recordings for', { exact: true }).inputValue(), '45', 'the retention after a reload');

        // Pausing asks first; cancelling changes nothing.
        const pause = page.getByRole('switch', { name: 'Pause the plan' });
        await pause.click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel' }).click();
        assertEq((await pause.getAttribute('aria-checked')) ?? undefined, 'false', 'after cancelling');
        assertEq((await backend.get('/v1/me', tokens.access_token)).status, 200, 'after cancelling');

        await pause.click();
        await page.getByRole('alertdialog').getByRole('button', { name: 'Pause the plan' }).click();
        await page.getByText('The plan is paused').waitFor();
        // The banner shows at once; the server's pause follows.
        await cue.waitFor(
            '/v1/me to answer plan_paused',
            15,
            async () => (await backend.get('/v1/me', tokens.access_token)).status === 503,
        );
        const paused = await backend.get('/v1/me', tokens.access_token);
        const body = (await paused.json()) as Failure;
        assertEq(body.error.code, 'plan_paused');
        assertEq(body.error.retryable, true);
        // The admin is not under /v1: it keeps working, and so does signing in.
        await admin.navigate('Overview');
        await page.getByText('spent in').waitFor();
        await admin.shot('paused');

        await admin.navigate('Settings');
        await page.getByRole('switch', { name: 'Pause the plan' }).click();
        await page.getByText('The plan is paused').waitFor({ state: 'detached' });
        await cue.waitFor('/v1/me to work again', 15, async () => (await backend.get('/v1/me', tokens.access_token)).status === 200);
        admin.assertClean();
    },
);
