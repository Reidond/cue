import { AdminPage, assertEq, e2eCase, fail } from '../harness/index.ts';

e2eCase(
    'The admin is a site of its own: it signs in through the API’s host and comes back, signs out, and only its origin may read the admin API.',
    async (cue) => {
        const owner = 'owner@cue.test';
        const backend = await cue.backend({ adminEmails: [owner] });
        const adminUrl = await backend.admin();
        if (adminUrl === new URL(backend.url).origin) fail('the admin and the backend share an origin');

        // Signing in leaves the admin for the backend's sign-in pages and ends back on the admin's own host, signed in.
        const admin = await AdminPage.signIn(backend, owner, { shots: cue.path('shots') });
        await admin.waitForShell();
        assertEq(new URL(admin.page.url()).origin, adminUrl, 'where the sign-in ends');

        // Signing out is the backend's too: the sign-in comes back, and stays after a reload (the session is gone, not just forgotten).
        await admin.page.getByRole('button', { name: 'Sign out' }).click();
        await admin.page.getByRole('link', { name: 'Continue with Google' }).waitFor();
        await admin.page.reload();
        await admin.page.getByRole('link', { name: 'Continue with Google' }).waitFor();
        assertEq(await admin.page.getByRole('navigation', { name: 'Admin' }).count(), 0, 'no admin after signing out');
        admin.assertClean();

        // The browser asks before a write: the admin's origin is told yes, with the cookie; another site is told nothing.
        const header = (response: Response, name: string) => response.headers.get(name) ?? 'none';
        const preflight = (origin: string) =>
            fetch(new URL('/admin/v1/settings', backend.url), {
                method: 'OPTIONS',
                headers: { origin, 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'content-type' },
            });
        const ours = await preflight(adminUrl);
        assertEq(ours.status, 204, "the admin's preflight");
        assertEq(header(ours, 'access-control-allow-origin'), adminUrl, "the admin's preflight: allowed origin");
        assertEq(header(ours, 'access-control-allow-credentials'), 'true', "the admin's preflight: with the cookie");
        assertEq(header(ours, 'access-control-allow-methods'), 'GET, POST, PATCH, DELETE', "the admin's preflight: methods");
        assertEq(header(await preflight('https://evil.example'), 'access-control-allow-origin'), 'none', "another site's preflight");

        // A refusal is an answer the admin must read (the sign-in it shows hangs on this 401); another site can't read it.
        const asked = (origin: string) => fetch(new URL('/admin/v1/session', backend.url), { headers: { origin } });
        const signedOut = await asked(adminUrl);
        assertEq(signedOut.status, 401, 'no session');
        assertEq(header(signedOut, 'access-control-allow-origin'), adminUrl, 'the admin reads the 401');
        assertEq(header(await asked('https://evil.example'), 'access-control-allow-origin'), 'none', 'another site reads nothing');
    },
);
