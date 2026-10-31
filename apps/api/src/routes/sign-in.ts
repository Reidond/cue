import { env } from 'cloudflare:workers';
import { Elysia, t } from 'elysia';
import { PROVIDERS } from '../auth.ts';
import { authFor } from '../context.ts';
import { inviteOnlyPage, signInFailedPage, signInPage } from '../pages.ts';

// The query `/oauth2/authorize` signed and sent to `/login`, minus its signature: what the browser must go back to once signed in.
const SIGNATURE_PARAMS = ['sig', 'exp', 'ba_param', 'ba_iat', 'ba_pl'];

// Elysia may read a numeric-looking query value (`exp`) as a number, so the schema is open and the values are made strings again.
const resumeOf = (query: Record<string, unknown>) =>
    new URLSearchParams(
        Object.entries(query).flatMap(([key, value]): [string, string][] => (SIGNATURE_PARAMS.includes(key) ? [] : [[key, String(value)]])),
    );

/** Sign-in: Better Auth's OAuth server, the identity providers' callbacks, and the pages a browser sees. */
export const signIn = new Elysia({ name: 'sign-in' })
    // A hook that rejects the new user surfaces from the identity provider's callback as a bare `403 {"message":"not_invited:EMAIL"}`
    // (`onAPIError.errorURL` doesn't apply to it); a browser needs a page. This route is more specific than the catch-all below, so it wins.
    .get(
        '/api/auth/callback/:provider',
        async ({ request }) => {
            const res = await authFor().handler(request);
            if (res.status !== 403) return res;
            const body = (await res
                .clone()
                .json()
                .catch(() => null)) as { message?: string } | null;
            const invited = /^not_invited(?::(.*))?$/.exec(body?.message ?? '');
            if (!invited) return res;
            const to = new URL('/invite-only', request.url);
            if (invited[1]) to.searchParams.set('email', invited[1]);
            return Response.redirect(to.toString(), 302);
        },
        { params: t.Object({ provider: t.String() }), detail: { hide: true } },
    )
    // The rest of /api/auth/* is Better Auth's, with the request untouched. Elysia reads a body before the handler unless a parser takes it,
    // and Better Auth then fails with "ReadableStream is locked": `parse: 'none'` is ignored under `cf dev`, a parser that claims the body
    // (and never reads it) is not.
    .all('/api/auth/*', ({ request }) => authFor().handler(request), { parse: () => true, detail: { hide: true } })
    // The authorization endpoint sends signed-out people here with the signed OAuth query.
    .get('/login', ({ query }) => signInPage(resumeOf(query), PROVIDERS), {
        query: t.Record(t.String(), t.Unknown()),
        detail: { hide: true },
    })
    // Starts the sign-in with one identity provider. When it's done the browser returns to the authorization endpoint with the original
    // parameters and a session, and that issues the code. (Passing the signed `oauth_query` instead makes the provider's callback answer
    // `302 Location: /` with the app's redirect only in a JSON body, which a browser never follows.)
    .get(
        '/login/:provider',
        async ({ params, query }) => {
            const res = await authFor().handler(
                new Request(`${env.PUBLIC_URL}/api/auth/sign-in/social`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', origin: env.PUBLIC_URL, accept: 'application/json' },
                    body: JSON.stringify({
                        provider: params.provider,
                        // The admin SPA signs in through the same pages and ends back in itself; the app's sign-in resumes the authorization.
                        callbackURL: query.next === 'admin' ? '/admin/' : `/api/auth/oauth2/authorize?${resumeOf(query).toString()}`,
                    }),
                }),
            );
            const { url } = (await res.json()) as { url?: string };
            if (!url) return signInFailedPage(null);
            const headers = new Headers({ location: url });
            for (const cookie of res.headers.getSetCookie()) headers.append('set-cookie', cookie);
            return new Response(null, { status: 302, headers });
        },
        {
            params: t.Object({ provider: t.Union([t.Literal('google'), t.Literal('github')]) }),
            query: t.Record(t.String(), t.Unknown()),
            detail: { hide: true },
        },
    )
    .get('/invite-only', ({ query }) => inviteOnlyPage(query.email ?? null), {
        query: t.Object({ email: t.Optional(t.String()) }),
        detail: { hide: true },
    })
    .get('/sign-in-failed', ({ query }) => signInFailedPage(query.error ?? null), {
        query: t.Object({ error: t.Optional(t.String()), error_description: t.Optional(t.String()) }),
        detail: { hide: true },
    });
