import { assertContains, assertEq, assertNotContains, e2eCase, fail } from '../harness/index.ts';
import { WINDOWS_CLIENT } from '../harness/oauth-client.ts';

interface Me {
    account: { email: string; role: string };
}

const meOf = async (backend: { get(path: string, token?: string): Promise<Response> }, token: string): Promise<Me> => {
    const response = await backend.get('/v1/me', token);
    assertEq(response.status, 200, "/v1/me with the Windows app's token");
    return (await response.json()) as Me;
};

e2eCase(
    'Cue for Windows is an OAuth client of its own: a loopback redirect on any port signs in, and the invite-only page sends it back there.',
    async (cue) => {
        const backend = await cue.backend();
        await backend.invite('win@cue.test');

        // The authorization code flow with PKCE, as the app does it: the redirect is http://127.0.0.1:PORT/oauth/callback.
        const tokens = await backend.tokensFor('win@cue.test', { client: 'windows' });
        assertEq((await meOf(backend, tokens.access_token)).account.email, 'win@cue.test');

        // The port is the system's choice each time: any one is accepted, with the same registration.
        const otherPort = { ...WINDOWS_CLIENT, redirectUri: 'http://127.0.0.1:61234/oauth/callback' };
        const again = await backend.tokensFor('win@cue.test', { client: otherPort });
        assertEq((await meOf(backend, again.access_token)).account.email, 'win@cue.test');

        // Only the registered address: not another host, another path, or the Mac's scheme.
        for (const redirectUri of [
            'http://localhost:49152/oauth/callback',
            'http://127.0.0.1:49152/elsewhere',
            'https://127.0.0.1:49152/oauth/callback',
        ]) {
            const refused = await backend.signInAs('win@cue.test', { client: { ...WINDOWS_CLIENT, redirectUri } });
            assertEq(refused.kind, 'failed', `${redirectUri} is not the Windows app's redirect`);
        }
        const crossed = await backend.signInAs('win@cue.test', { client: { ...WINDOWS_CLIENT, clientId: 'cue-mac' } });
        assertEq(crossed.kind, 'failed', "the Mac's client doesn't take the Windows redirect");

        // Its refresh token rotates for its own client, and Sign Out revokes it.
        const refreshed = await backend.refresh(tokens.refresh_token, 'windows');
        if (!refreshed.body.access_token || !refreshed.body.refresh_token)
            fail('the refresh token did not refresh', JSON.stringify(refreshed));
        assertEq((await backend.revoke(refreshed.body.refresh_token, 'windows')) < 300, true, 'revoking');
        assertEq((await backend.refresh(refreshed.body.refresh_token, 'windows')).body.error, 'invalid_grant', 'a revoked refresh token');

        // Not on the list: the page says whose email it was, and "Return to Cue" goes back to the app that asked, on its own port.
        const stranger = await backend.signInAs('stranger@cue.test', { client: 'windows', readPages: true });
        if (stranger.kind !== 'not_invited') return fail('the stranger was not turned away', JSON.stringify(stranger));
        assertEq(stranger.email ?? undefined, 'stranger@cue.test');
        const page = cue.save('invite-only-windows.html', stranger.page ?? '');
        assertContains(page, /Cue is invite-only/);
        assertContains(
            page,
            /href="http:\/\/127\.0\.0\.1:49152\/oauth\/callback\?error=access_denied&#38;error_description=not_invited&#38;email=stranger%40cue\.test"/,
        );
        assertNotContains(page, /com\.andriishafar\.cue:/);

        // The Mac's page is as it was.
        const mac = await backend.signInAs('stranger@cue.test', { readPages: true });
        if (mac.kind !== 'not_invited') return fail('the stranger was not turned away on the Mac', JSON.stringify(mac));
        const macPage = cue.save('invite-only-mac.html', mac.page ?? '');
        assertContains(
            macPage,
            /href="com\.andriishafar\.cue:\/oauth\/callback\?error=access_denied&#38;error_description=not_invited&#38;email=stranger%40cue\.test"/,
        );

        // Someone who found the page without signing in through an app is sent to the Mac's, as before.
        const bare = await (await fetch(new URL('/invite-only?email=bob%40cue.test', backend.url))).text();
        assertContains(cue.save('invite-only-bare.html', bare), /href="com\.andriishafar\.cue:\/oauth\/callback\?/);
        // And a cookie that isn't an app's own address is not followed.
        const forged = await (
            await fetch(new URL('/invite-only?email=bob%40cue.test', backend.url), {
                headers: { cookie: 'cue_return=https%3A%2F%2Fevil.example%2Fcallback' },
            })
        ).text();
        assertNotContains(cue.save('invite-only-forged.html', forged), /evil\.example/);
    },
);
