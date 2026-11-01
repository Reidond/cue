import { assertContains, assertEq, e2eCase, exists, isDirectory, literal } from '../harness/index.ts';

e2eCase('An invited email signs in with Sign In, nothing works before that, and the next launch signs in on its own.', async (cue) => {
    const backend = await cue.backend();
    await backend.invite(cue.email);
    backend.idp.approveAs(cue.email);
    await cue.launch({}, { signIn: false });

    // Signed out, a click that would start something does nothing.
    cue.control('new Early');
    await cue.waitLog(/⚠︎ Sign in to Cue first/, 20);
    assertEq(cue.signedIn, false, 'nothing is kept before signing in');

    cue.control('signin');
    await cue.waitLog(/🔑 Signed in to Cue as /, 60);
    assertContains(cue.sessionLog(), new RegExp(`Signed in to Cue as ${literal(cue.email)}$`));
    assertEq(cue.signedIn, true, 'the refresh token is kept');

    cue.control('new Talk');
    await cue.waitFor('the project', 20, () => isDirectory(cue.projectPath('Talk')));
    assertEq(exists(cue.projectPath('Early')), false, 'the project asked for before signing in was never made');

    // The refresh token is all the next launch needs.
    await cue.stop();
    await cue.launch({}, { signIn: false });
    await cue.waitLog(/🔑 Signed in to Cue as /, 30);
    assertEq(cue.logCount(/Sign in to Cue first/), 0, 'nobody had to sign in again');
});
