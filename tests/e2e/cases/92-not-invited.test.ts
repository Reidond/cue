import { assertContains, assertEq, e2eCase } from '../harness/index.ts';

e2eCase("An email that isn't invited is refused: Cue says so, keeps nothing and stays signed out.", async (cue) => {
    const backend = await cue.backend();
    backend.idp.approveAs('stranger@cue.test');
    await cue.launch({}, { signIn: false });

    cue.control('signin');
    await cue.waitLog(/⚠︎ Not invited: stranger@cue\.test/, 60);
    assertEq(cue.signedIn, false, 'no refresh token');
    assertEq(cue.logCount(/Signed in to Cue/), 0);

    // Still signed out: starting Cue does nothing.
    cue.control('start Anything');
    await cue.waitLog(/⚠︎ Sign in to Cue first/, 20);

    // Once they are invited, signing in again works.
    await backend.invite('stranger@cue.test');
    cue.control('signin');
    await cue.waitLog(/🔑 Signed in to Cue as stranger@cue\.test/, 60);
    assertContains(cue.sessionLog(), /Not invited: stranger@cue\.test/);
});
