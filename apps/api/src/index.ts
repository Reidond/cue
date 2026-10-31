/// <reference types="vite/client" />
import { openapi } from '@elysiajs/openapi';
import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { ApiError, errorResponse } from './errors.ts';
import { admin } from './routes/admin.ts';
import { liveSocket } from './routes/calls.ts';
import { signIn } from './routes/sign-in.ts';
import { v1 } from './routes/v1.ts';

// `cf dev` imports the entry from inside a request-scoped callback, where workerd forbids `Function(...)`
// (what Elysia's AoT compiler uses). Production evaluates it at startup, where it's allowed.
const dev = import.meta.env.DEV;

// Routing is Elysia's alone: every route is declared on a plugin per feature with typed params and TypeBox schemas, and the Worker's
// `fetch` is this app's. Nothing in the backend switches on a request's path by hand (AGENTS.md › The backend).
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
    .get('/', () => ({ name: 'Cue API', version: 1 }))
    .use(signIn)
    .use(v1)
    .use(liveSocket)
    .use(admin);

export type App = typeof routes;
export default dev ? routes : routes.compile();

// The Durable Object class of live calls, bound as `CALL` (cloudflare.config.ts).
export { Call } from './call/call.ts';
