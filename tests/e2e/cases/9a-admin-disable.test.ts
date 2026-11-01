import { AdminPage, assertEq, e2eCase } from '../harness/index.ts';

e2eCase('Disabling a user in the admin ends their access at once, after a confirmation; enabling lets them back.', async (cue) => {
    const owner = 'owner@cue.test';
    const person = 'person@cue.test';
    const backend = await cue.backend({ adminEmails: [owner] });
    await backend.invite(person);
    const tokens = await backend.tokensFor(person);
    assertEq((await backend.get('/v1/me', tokens.access_token)).status, 200, 'before disabling');

    const admin = await AdminPage.signIn(backend, owner, { shots: cue.path('shots') });
    const { page } = admin;
    await admin.waitForShell();
    await admin.navigate('Users');
    await page.getByRole('link', { name: 'person', exact: true }).click();
    await page.getByRole('heading', { name: 'person' }).waitFor();

    // The confirmation says what happens, and cancelling does nothing.
    await page.getByRole('button', { name: 'Disable' }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.getByText('signed out of Cue everywhere').waitFor();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await dialog.waitFor({ state: 'detached' });
    assertEq((await backend.get('/v1/me', tokens.access_token)).status, 200, 'after cancelling');

    await page.getByRole('button', { name: 'Disable' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Disable' }).click();
    await page.getByRole('main').getByText('Disabled', { exact: true }).waitFor();

    // The page shows the new state at once; the server's follows. The access token is valid for minutes, and the denylist refuses it now.
    // The refresh token and a new sign-in are refused too.
    await cue.waitFor('the access token to be refused', 15, async () => (await backend.get('/v1/me', tokens.access_token)).status === 401);
    assertEq((await backend.refresh(tokens.refresh_token)).body.error, 'invalid_grant', 'the refresh token of a disabled user');
    assertEq((await backend.signInAs(person)).kind === 'code', false, 'signing in again as a disabled user');

    // The list shows it.
    await admin.navigate('Users');
    await page
        .getByRole('row', { name: /person@cue.test/ })
        .getByText('Disabled')
        .waitFor();

    // Enable: back in.
    await page.getByRole('link', { name: 'person', exact: true }).click();
    await page.getByRole('button', { name: 'Enable' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Enable' }).click();
    await page.getByRole('main').getByText('Active', { exact: true }).waitFor();
    await cue.waitFor('the person to be let in', 15, async () => (await backend.signInAs(person)).kind === 'code');
    const back = await backend.tokensFor(person);
    assertEq((await backend.get('/v1/me', back.access_token)).status, 200, 'after enabling');

    // The owner cannot disable themselves.
    await admin.navigate('Users');
    await page.getByRole('link', { name: 'owner', exact: true }).click();
    await page.getByRole('button', { name: 'Disable' }).waitFor();
    assertEq(await page.getByRole('button', { name: 'Disable' }).isDisabled(), true, "the owner's own Disable button");

    admin.assertClean();
    await admin.shot('disabled');
});
