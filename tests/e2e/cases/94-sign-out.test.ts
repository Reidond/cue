import { assertEq, e2eCase, fail } from '../harness/index.ts';

e2eCase('Sign Out revokes the refresh token, forgets it, and the next launch starts signed out.', async (cue) => {
    const backend = await cue.backend();
    await cue.launch();
    const token = cue.refreshToken ?? fail('Cue is signed in, so it has a refresh token');

    cue.control('signout');
    await cue.waitLog(/🔑 Signed out of Cue/, 30);
    assertEq(cue.signedIn, false, 'the refresh token is forgotten');
    assertEq((await backend.refresh(token)).body.error, 'invalid_grant', 'the backend no longer takes the refresh token');

    // Nothing is left to sign in with.
    await cue.stop();
    await cue.launch({}, { signIn: false });
    cue.control('new Talk');
    await cue.waitLog(/⚠︎ Sign in to Cue first/, 20);
    assertEq(cue.logCount(/Signed in to Cue/), 0, 'the new launch is signed out');
});
