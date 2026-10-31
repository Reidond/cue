import { assertEq, assertContains, e2eCase, fail } from '../harness/index.ts';

interface Me {
    account: { id: string; email: string; name: string; role: string };
    plan: { id: string; name: string };
    limits: { monthlyUsd: number | null };
    usage: { month: string; usd: number; audioSeconds: number };
}

e2eCase('Only an invited email that Google or GitHub vouches for signs in, and /v1/me says who it is.', async (cue) => {
    const backend = await cue.backend({ adminEmails: ['owner@cue.test'] });
    const alice = 'alice@cue.test';
    await backend.invite(alice);

    // Invited, with Google: tokens, and /v1/me.
    const tokens = await backend.tokensFor(alice);
    const me = await backend.get('/v1/me', tokens.access_token);
    assertEq(me.status, 200, '/v1/me with a valid token');
    const body = (await me.json()) as Me;
    assertEq(body.account.email, alice);
    assertEq(body.account.role, 'user');
    assertEq(body.plan.id, 'cue');
    assertEq(body.usage.audioSeconds, 0);
    assertEq(String(body.limits.monthlyUsd), '20', 'the default monthly limit');

    // The same person with GitHub is the same user.
    const viaGithub = await backend.tokensFor(alice, { provider: 'github' });
    const again = (await (await backend.get('/v1/me', viaGithub.access_token)).json()) as Me;
    assertEq(again.account.id, body.account.id, 'GitHub and Google are one user');

    // Not on the list: no code, and the page says whose email it was.
    const bob = await backend.signInAs('bob@cue.test');
    assertEq(JSON.stringify(bob), JSON.stringify({ kind: 'not_invited', email: 'bob@cue.test' }));
    const page = await (await fetch(new URL('/invite-only?email=bob%40cue.test', backend.url))).text();
    assertContains(cue.save('invite-only.html', page), /Cue is invite-only/);

    // On the list, but the provider has not verified the email.
    await backend.invite('carol@cue.test');
    const carol = await backend.signInAs('carol@cue.test', { verified: false });
    assertEq(carol.kind, 'not_invited', 'an unverified email');
    const github = await backend.signInAs('carol@cue.test', { provider: 'github', verified: false });
    assertEq(github.kind, 'not_invited', 'an unverified GitHub email');

    // The owner needs no invite, and is the admin.
    const owner = await backend.tokensFor('owner@cue.test');
    const ownerMe = (await (await backend.get('/v1/me', owner.access_token)).json()) as Me;
    assertEq(ownerMe.account.role, 'admin');

    // Errors have one shape.
    const unauthorized = await backend.get('/v1/me');
    assertEq(unauthorized.status, 401);
    assertEq(
        JSON.stringify(await unauthorized.json()),
        JSON.stringify({ error: { code: 'unauthorized', message: 'Sign in to Cue.', retryable: false } }),
    );
    const garbage = await backend.get('/v1/me', 'a.b.c');
    assertEq(garbage.status, 401);
    const missing = await backend.get('/v1/nothing', tokens.access_token);
    assertEq(missing.status, 404);
    const missingBody = (await missing.json()) as { error?: { code?: string } };
    assertEq(missingBody.error?.code, 'not_found');

    // The OpenAPI document describes the route.
    const spec = (await (await backend.get('/v1/openapi.json')).json()) as { paths?: Record<string, unknown> };
    if (!spec.paths?.['/v1/me']) fail('the OpenAPI document has no /v1/me', JSON.stringify(spec).slice(0, 500));
});
