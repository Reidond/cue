import { assertEq, e2eCase } from '../harness/index.ts';

e2eCase('Disabling a user ends their access at once and keeps them out; inviting again lets them back.', async (cue) => {
    const backend = await cue.backend();
    await backend.invite(cue.email);
    const tokens = await backend.tokensFor(cue.email);
    assertEq((await backend.get('/v1/me', tokens.access_token)).status, 200, 'before disabling');

    await backend.disable(cue.email);

    // The access token is still valid for minutes; the denylist refuses it now.
    assertEq((await backend.get('/v1/me', tokens.access_token)).status, 401, 'the access token of a disabled user');
    assertEq((await backend.refresh(tokens.refresh_token)).body.error, 'invalid_grant', 'the refresh token of a disabled user');
    assertEq((await backend.signInAs(cue.email)).kind === 'code', false, 'signing in again as a disabled user');

    await backend.invite(cue.email);
    const back = await backend.tokensFor(cue.email);
    assertEq((await backend.get('/v1/me', back.access_token)).status, 200, 'after inviting again');
});
