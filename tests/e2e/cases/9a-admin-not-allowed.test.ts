import { AdminClient, AdminPage, assertEq, browser, e2eCase } from '../harness/index.ts';

e2eCase(
    'Only an owner gets the admin: a member sees "Not allowed", and the admin API refuses them, strangers and other sites.',
    async (cue) => {
        const owner = 'owner@cue.test';
        const member = 'member@cue.test';
        const backend = await cue.backend({ adminEmails: [owner] });
        await backend.invite(member);

        // No session: the API says to sign in, and the page offers the sign-in.
        const stranger = await fetch(new URL('/admin/v1/overview', backend.url));
        assertEq(stranger.status, 401, 'the API without a session');
        const signedOut = await (await browser()).newPage();
        await signedOut.goto(`${backend.url}/admin/users`);
        await signedOut.getByRole('link', { name: 'Continue with Google' }).waitFor();
        await signedOut.close();

        // A member signs in with the same pages and gets a plain "Not allowed".
        const admin = await AdminPage.signIn(backend, member, { shots: cue.path('shots') });
        await admin.page.getByRole('heading', { name: 'Not allowed' }).waitFor();
        await admin.page.getByText(member).waitFor();
        assertEq(await admin.page.getByRole('navigation', { name: 'Admin' }).count(), 0, 'no admin navigation for a member');
        await admin.shot('not-allowed');

        // Their session is a session, and still not the owner's: every route but "who am I" refuses.
        const asMember = await backend.adminAs(member);
        const who = await asMember.get('/session');
        assertEq(who.status, 200);
        assertEq((who.body as { role: string }).role, 'user');
        for (const path of ['/overview', '/users', '/invites', '/settings'])
            assertEq((await asMember.get(path)).status, 403, `GET ${path} as a member`);
        assertEq((await asMember.call('POST', '/invites', { email: 'x@cue.test' })).status, 403, 'POST /invites as a member');

        // The owner gets in; a write from another site is refused even with the owner's cookie.
        const asOwner: AdminClient = await backend.adminAs(owner);
        assertEq((await asOwner.get('/overview')).status, 200, 'GET /overview as the owner');
        assertEq(
            (await asOwner.call('PATCH', '/settings', { planPaused: true }, 'https://evil.example')).status,
            403,
            'a write from another origin',
        );
        assertEq(((await asOwner.get('/settings')).body as { planPaused: boolean }).planPaused, false, 'nothing changed');
        admin.assertClean();
    },
);
