import { assertContains, assertEq, e2eCase } from '../harness/index.ts';

e2eCase('A disabled user is signed out, and cannot sign in again until invited.', async (cue) => {
    const backend = await cue.backend();
    await cue.launch({ CUE_ME_TICK: '2' });

    await backend.disable(cue.email);
    await cue.waitLog(/🔑 Signed out of Cue/, 60);
    assertContains(cue.sessionLog(), /⚠︎ Your Cue session ended/);
    assertEq(cue.signedIn, false, 'the refresh token is forgotten');

    cue.control('signin');
    await cue.waitLog(/⚠︎ (Couldn't sign in to Cue|Not invited)/, 60);
    assertEq(cue.signedIn, false, 'a disabled user stays out');

    await backend.invite(cue.email);
    cue.control('signin');
    await cue.waitLog(/🔑 Signed in to Cue as /, 60);
});
