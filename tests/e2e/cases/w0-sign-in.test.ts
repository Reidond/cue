import { assertContains, assertEq, e2eCase, fail, literal } from '../harness/index.ts';

e2eCase(
    'Cue for Windows: an invited email signs in with Sign In (Google or GitHub), nothing works before that, and the next launch signs in on its own.',
    async (cue) => {
        const backend = await cue.backend();
        await backend.invite(cue.email);
        backend.idp.approveAs(cue.email);
        await cue.launch({}, { signIn: false });

        // Signed out, a click that would start something does nothing.
        cue.control('new Early');
        await cue.waitLog(/⚠︎ Sign in to Cue first \(new ignored\)/, 20);
        assertEq(cue.signedIn, false, 'nothing is kept before signing in');
        assertContains(cue.sessionLog(), /🤖 Claude: Cue plan/);
        assertContains(cue.sessionLog(), /🗣 Speech recognition: Cue plan/);

        // Sign In: the browser's part is the stand-in provider's, Cue's own is real (the loopback redirect, the code, the tokens).
        cue.control('signin');
        await cue.waitLog(/🔑 Signed in to Cue as /, 60);
        assertContains(cue.sessionLog(), new RegExp(`Signed in to Cue as ${literal(cue.email)}$`));
        assertEq(cue.signedIn, true, 'the refresh token is kept');
        if (!cue.refreshToken) fail('Cue is signed in, so it has a refresh token');

        // The backend knows Cue for Windows as its own client.
        const clients = (await backend.rows('SELECT clientId FROM oauthRefreshToken')).map((row) => row['clientId']);
        assertEq(JSON.stringify(clients), JSON.stringify(['cue-windows']), "the refresh token is the Windows client's");

        // Sign out and in again with GitHub: the same person.
        cue.control('signout');
        await cue.waitLog(/🔑 Signed out of Cue/, 30);
        assertEq(cue.signedIn, false);
        const before = cue.logCount(/🔑 Signed in to Cue as /);
        cue.control('signin github');
        await cue.waitFor('the second sign-in', 60, () => cue.logCount(/🔑 Signed in to Cue as /) === before + 1);
        assertEq(cue.logCount(new RegExp(`Signed in to Cue as ${literal(cue.email)}$`)), 2, 'GitHub and Google are one user');

        // The refresh token is all the next launch needs.
        await cue.stop();
        await cue.launch({}, { signIn: false });
        await cue.waitLog(/🔑 Signed in to Cue as /, 30);
        assertEq(cue.logCount(/Sign in to Cue first/), 0, 'nobody had to sign in again');
    },
);
