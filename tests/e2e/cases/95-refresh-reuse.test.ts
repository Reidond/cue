import { assertEq, e2eCase, fail } from '../harness/index.ts';

e2eCase('A refresh token used twice is rejected, and it ends the session it came from.', async (cue) => {
    const backend = await cue.backend();
    await backend.invite(cue.email);
    const first = await backend.tokensFor(cue.email);

    const rotated = await backend.refresh(first.refresh_token);
    assertEq(rotated.status, 200, 'the first use of a refresh token');
    const second = rotated.body.refresh_token;
    if (!second || second === first.refresh_token) fail('a refresh must hand out a new refresh token', JSON.stringify(rotated.body));

    const reused = await backend.refresh(first.refresh_token);
    assertEq(reused.body.error, 'invalid_grant', 'the second use of the same refresh token');

    // Someone else may hold the old token: using it ends the whole session, the new refresh token included.
    const after = await backend.refresh(second);
    assertEq(after.body.error, 'invalid_grant', 'the rotated token after the old one was replayed');
});
