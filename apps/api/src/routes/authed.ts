import { env } from 'cloudflare:workers';
import { Elysia } from 'elysia';
import { authFor } from '../context.ts';
import { authenticate } from '../token.ts';

/** Gives the routes of a plugin `userId`: whoever the bearer token belongs to (a request without a good one is `unauthorized`). */
export const authed = new Elysia({ name: 'authed' }).resolve({ as: 'scoped' }, async ({ request }) => {
    const { userId } = await authenticate(request, authFor, env.PUBLIC_URL, env.DENYLIST);
    return { userId };
});
