import { AdminPage, assertEq, e2eCase } from '../harness/index.ts';

e2eCase('Inviting an email in the admin lets that person sign in to Cue; revoking an unused invite shuts the door again.', async (cue) => {
    const owner = 'owner@cue.test';
    const backend = await cue.backend({ adminEmails: [owner] });
    const admin = await AdminPage.signIn(backend, owner, { shots: cue.path('shots') });
    const { page } = admin;
    await admin.waitForShell();
    await admin.navigate('Invites');

    // Not on the list: no way in.
    const friend = 'friend@cue.test';
    assertEq((await backend.signInAs(friend)).kind, 'not_invited', 'before the invite');

    await page.getByLabel('Email address').fill(friend);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await page.getByText(`${friend} is invited.`).waitFor();
    const waiting = page.getByRole('region', { name: 'Waiting to sign in' });
    await waiting.getByText(friend).waitFor();
    await waiting.getByText('Pending').waitFor();

    // The same address twice, and something that is not an address, are refused in words.
    await page.getByLabel('Email address').fill(friend);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await page.getByText(`${friend} is already invited.`).waitFor();
    await page.getByLabel('Email address').fill('not an email');
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await page.getByText('That is not an email address.').waitFor();

    // The invited person signs in to the app (the same path as the Mac app's) and /v1/me knows them.
    const tokens = await backend.tokensFor(friend);
    const me = (await (await backend.get('/v1/me', tokens.access_token)).json()) as { account: { email: string; role: string } };
    assertEq(me.account.email, friend);
    assertEq(me.account.role, 'user');

    // Their invite has moved to "Signed in".
    await page.reload();
    await page.getByRole('region', { name: 'Signed in' }).getByText(friend).waitFor();
    await page.getByRole('region', { name: 'Signed in' }).getByText('Accepted').waitFor();
    assertEq(await waiting.getByText(friend).count(), 0, 'the accepted invite is not waiting any more');

    // An invite nobody used can be withdrawn.
    const later = 'later@cue.test';
    await page.getByLabel('Email address').fill(later);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    await waiting.getByText(later).waitFor();
    await page.getByRole('button', { name: `Revoke the invite for ${later}` }).click();
    await waiting.getByText(later).waitFor({ state: 'detached' });
    assertEq((await backend.signInAs(later)).kind, 'not_invited', 'after revoking');

    admin.assertClean();
    await admin.shot('invites');
});
