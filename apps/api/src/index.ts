/// <reference types="vite/client" />
import { openapi } from '@elysiajs/openapi';
import { ApiError as ApiErrorBody, Me } from '@cue/contract';
import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { env } from 'cloudflare:workers';
import { adminEmails, createAuth, PROVIDERS, type Provider } from './auth.ts';
import { ApiError, errorResponse } from './errors.ts';
import { inviteOnlyPage, signInFailedPage, signInPage } from './pages.ts';
import { authenticate } from './token.ts';

// `cf dev` imports the entry from inside a request-scoped callback, where workerd forbids `Function(...)`
// (what Elysia's AoT compiler uses). Production evaluates it at startup, where it's allowed.
const dev = import.meta.env.DEV;

// Built per request from `env`: bindings only exist per isolate, and nothing is kept between requests.
const authFor = () => createAuth(env, env.DB);

// The query `/oauth2/authorize` signed and sent to `/login`, minus its signature: what the browser must go back to once signed in.
const SIGNATURE_PARAMS = ['sig', 'exp', 'ba_param', 'ba_iat', 'ba_pl'];

// A hook that rejects the new user surfaces from the identity provider's callback as a bare `403 {"message":"not_invited:EMAIL"}`
// (`onAPIError.errorURL` doesn't apply to it); a browser needs a page.
async function signInCallback(request: Request): Promise<Response> {
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
}

// `/login/:provider`: starts the sign-in with that identity provider. When it's done the browser returns to the authorization
// endpoint with the original parameters and a session, and that issues the code. (Passing the signed `oauth_query` instead makes the
// provider's callback answer `302 Location: /` with the app's redirect only in a JSON body, which a browser never follows.)
async function startSignIn(request: Request, provider: string): Promise<Response> {
    if (!PROVIDERS.includes(provider as Provider)) return errorResponse('not_found', 'Unknown sign-in provider.');
    const resume = new URL(request.url).searchParams;
    for (const key of SIGNATURE_PARAMS) resume.delete(key);
    const res = await authFor().handler(
        new Request(new URL('/api/auth/sign-in/social', request.url), {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: env.PUBLIC_URL, accept: 'application/json' },
            body: JSON.stringify({ provider, callbackURL: `/api/auth/oauth2/authorize?${resume.toString()}` }),
        }),
    );
    const { url } = (await res.json()) as { url?: string };
    if (!url) return signInFailedPage(null);
    const headers = new Headers({ location: url });
    for (const cookie of res.headers.getSetCookie()) headers.append('set-cookie', cookie);
    return new Response(null, { status: 302, headers });
}

const routes = new Elysia({ adapter: CloudflareAdapter, aot: !dev })
    .onError(({ error, code }) => {
        if (error instanceof ApiError) return errorResponse(error.code, error.message, error.retryable);
        if (code === 'NOT_FOUND') return errorResponse('not_found', 'Not found.');
        if (code === 'VALIDATION' || code === 'PARSE') return errorResponse('bad_request', 'The request is not valid.');
        console.error('unhandled', error);
        return errorResponse('internal', 'Something went wrong on our side.', true);
    })
    .use(
        openapi({
            path: '/v1/docs',
            specPath: '/v1/openapi.json',
            provider: null,
            documentation: { info: { title: 'Cue API', version: '1.0.0' } },
        }),
    )
    // Better Auth owns /api/auth/* and the discovery documents. `.mount` hands it the untouched request: a plain
    // `.all()` makes Elysia read the body first, and Better Auth then fails with "ReadableStream is locked".
    // (Later routes that return a WebSocket's 101 or need an unread body go here too.)
    .mount((request) => {
        const { pathname } = new URL(request.url);
        if (pathname.startsWith('/api/auth/callback/')) return signInCallback(request);
        if (pathname.startsWith('/api/auth/') || pathname.startsWith('/.well-known/')) return authFor().handler(request);
        return errorResponse('not_found', 'Not found.');
    })
    .get('/', () => ({ name: 'Cue API', version: 1 }))
    // The authorization endpoint sends signed-out people here with the signed OAuth query.
    .get('/login', ({ request }) => {
        const resume = new URL(request.url).searchParams;
        for (const key of SIGNATURE_PARAMS) resume.delete(key);
        return signInPage(resume, PROVIDERS);
    })
    .get('/login/:provider', ({ request, params }) => startSignIn(request, params.provider))
    .get('/invite-only', ({ query }) => inviteOnlyPage(query.email ?? null))
    .get('/sign-in-failed', ({ query }) => signInFailedPage(query.error ?? null))
    .get(
        '/v1/me',
        async ({ request }) => {
            const { userId } = await authenticate(request, authFor, env.PUBLIC_URL, env.DENYLIST);
            const user = await env.DB.prepare('SELECT id, email, name, role FROM user WHERE id = ?').bind(userId).first<{
                id: string;
                email: string;
                name: string;
                role: string | null;
            }>();
            if (!user) throw new ApiError('unauthorized', 'This account no longer exists.');
            return {
                account: {
                    id: user.id,
                    email: user.email,
                    name: user.name,
                    role:
                        user.role === 'admin' || adminEmails(env).includes(user.email.toLowerCase())
                            ? ('admin' as const)
                            : ('user' as const),
                },
                plan: { id: 'cue' as const, name: 'Cue' },
                // Placeholders: PR 7 prices the usage and enforces the limit.
                limits: { monthlyUsd: null },
                usage: { month: new Date().toISOString().slice(0, 7), usd: 0, audioSeconds: 0 },
            };
        },
        { response: { 200: Me, 401: ApiErrorBody }, detail: { summary: 'The signed-in account, its plan, limits and usage this month' } },
    );

export type App = typeof routes;
export default dev ? routes : routes.compile();
