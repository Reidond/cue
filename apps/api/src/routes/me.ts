import { ApiError as ApiErrorBody, Me } from '@cue/contract';
import { env } from 'cloudflare:workers';
import { Elysia } from 'elysia';
import { adminEmails } from '../auth.ts';
import { authFor } from '../context.ts';
import { ApiError } from '../errors.ts';
import { authenticate } from '../token.ts';

/** The signed-in account. */
export const me = new Elysia({ name: 'me' }).get(
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
                role: user.role === 'admin' || adminEmails(env).includes(user.email.toLowerCase()) ? ('admin' as const) : ('user' as const),
            },
            plan: { id: 'cue' as const, name: 'Cue' },
            // Placeholders: PR 7 prices the usage and enforces the limit.
            limits: { monthlyUsd: null },
            usage: { month: new Date().toISOString().slice(0, 7), usd: 0, audioSeconds: 0 },
        };
    },
    { response: { 200: Me, 401: ApiErrorBody }, detail: { summary: 'The signed-in account, its plan, limits and usage this month' } },
);
