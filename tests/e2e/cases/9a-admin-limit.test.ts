import { AdminPage, assertEq, e2eCase } from '../harness/index.ts';

interface Me {
    limits: { monthlyUsd: number };
    usage: { usd: number };
}

e2eCase("Changing a user's monthly limit in the admin changes what /v1/me reports, and the default can be put back.", async (cue) => {
    const owner = 'owner@cue.test';
    const person = 'person@cue.test';
    const backend = await cue.backend({ adminEmails: [owner] });
    await backend.invite(person);
    const tokens = await backend.tokensFor(person);
    const me = async () => (await (await backend.get('/v1/me', tokens.access_token)).json()) as Me;
    assertEq((await me()).limits.monthlyUsd, 20, 'the default limit at the start');

    await backend.seedUsage(person, [{ feature: 'answer', usd: 1.25 }]);
    assertEq((await me()).usage.usd, 1.25, 'spend that /v1/me reports');

    const admin = await AdminPage.signIn(backend, owner, { shots: cue.path('shots') });
    const { page } = admin;
    await admin.waitForShell();
    await admin.navigate('Users');

    // Search finds them; their row opens their page.
    await page.getByRole('searchbox', { name: 'Search users' }).fill('person@');
    await page.getByRole('link', { name: 'person', exact: true }).click();
    await page.getByRole('heading', { name: 'person' }).waitFor();
    await page.getByText('$1.25').first().waitFor();
    await page.getByText('Default', { exact: true }).waitFor();

    const field = page.getByLabel('Monthly limit in dollars', { exact: true });
    await field.fill('35');
    await field.press('Tab');
    await page.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Set for them', { exact: true }).waitFor();
    // The page shows the new limit at once; the server's answer follows.
    await cue.waitFor('/v1/me to report the new limit', 15, async () => (await me()).limits.monthlyUsd === 35);

    // It survives a reload, and the list shows it.
    await page.reload();
    await page.getByText('$35.00 set for them').waitFor();

    await page.getByRole('button', { name: /^Use the default/ }).click();
    await page.getByText('Default', { exact: true }).waitFor();
    await cue.waitFor('/v1/me to report the default again', 15, async () => (await me()).limits.monthlyUsd === 20);

    admin.assertClean();
    await admin.shot('user');
});
