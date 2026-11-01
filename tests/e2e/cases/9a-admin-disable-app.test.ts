import { AdminPage, assertContains, assertEq, e2eCase } from '../harness/index.ts';

e2eCase('A user the admin disables is signed out of the Mac app, and signs in again once enabled.', async (cue) => {
    const owner = 'owner@cue.test';
    const backend = await cue.backend({ adminEmails: [owner] });
    await cue.launch({ CUE_ME_TICK: '2' });

    const admin = await AdminPage.signIn(backend, owner, { shots: cue.path('shots') });
    const { page } = admin;
    await admin.waitForShell();
    await admin.navigate('Users');
    await page.getByRole('searchbox', { name: 'Search users' }).fill(cue.email);
    await page.getByRole('link', { name: cue.email.split('@')[0]!, exact: true }).click();
    await page.getByRole('button', { name: 'Disable' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Disable' }).click();
    await page.getByRole('main').getByText('Disabled', { exact: true }).waitFor();

    await cue.waitLog(/🔑 Signed out of Cue/, 60);
    assertContains(cue.sessionLog(), /⚠︎ Your Cue session ended/);
    assertEq(cue.signedIn, false, 'the refresh token is forgotten');

    await page.getByRole('button', { name: 'Enable' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Enable' }).click();
    await page.getByRole('main').getByText('Active', { exact: true }).waitFor();
    backend.idp.approveAs(cue.email);
    cue.control('signin');
    await cue.waitLog(/🔑 Signed in to Cue as /, 60);
});
