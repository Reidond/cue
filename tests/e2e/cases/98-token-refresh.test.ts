import { assertEq, e2eCase, fail } from '../harness/index.ts';

e2eCase('An expired access token is refreshed without the user noticing.', async (cue) => {
    // Access tokens live 5 s here and Cue reads its account every 7 s: the one it holds has expired by then.
    await cue.backend({ accessTokenSeconds: 5 });
    await cue.launch({ CUE_ME_TICK: '7' });
    const before = cue.refreshToken ?? fail('signed in, so a refresh token');

    await cue.waitLog(/🔑 Cue access refreshed/, 60);
    assertEq(cue.logCount(/Signed out of Cue/), 0, 'still signed in');
    assertEq(cue.logCount(/Your Cue session ended/), 0, 'nothing went wrong');
    const after = cue.refreshToken ?? fail('still has a refresh token');
    assertEq(after !== before, true, 'the refresh token was replaced (they rotate)');
    // Several rounds later it is still working.
    await cue.waitFor('another refresh', 60, () => cue.logCount(/🔑 Cue access refreshed/) >= 2);
    assertEq(cue.logCount(/Signed out of Cue/), 0, 'still signed in');
});
