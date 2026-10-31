import { ApiError as ApiErrorBody, Me } from '@cue/contract';
import { env } from 'cloudflare:workers';
import { Elysia } from 'elysia';
import { adminEmails } from '../auth.ts';
import { ApiError } from '../errors.ts';
import { accountUsage, monthOf } from '../usage.ts';
import { authed } from './authed.ts';

/** The signed-in account. */
export const me = new Elysia({ name: 'me' }).use(authed).get(
    '/me',
    async ({ userId }) => {
        const user = await env.DB.prepare('SELECT id, email, name, role FROM user WHERE id = ?').bind(userId).first<{
            id: string;
            email: string;
            name: string;
            role: string | null;
        }>();
        if (!user) throw new ApiError('unauthorized', 'This account no longer exists.');
        const month = monthOf();
        const usage = await accountUsage(env.DB, userId, month);
        return {
            account: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role === 'admin' || adminEmails(env).includes(user.email.toLowerCase()) ? ('admin' as const) : ('user' as const),
            },
            plan: { id: 'cue' as const, name: 'Cue' },
            limits: { monthlyUsd: usage.limitUsd },
            usage: {
                month,
                usd: usage.usd,
                audioSeconds: usage.audioSeconds,
                limitReached: usage.usd >= usage.limitUsd,
                byFeature: usage.byFeature,
                periodStart: usage.periodStart,
                periodEnd: usage.periodEnd,
            },
        };
    },
    { response: { 200: Me, 401: ApiErrorBody, 429: ApiErrorBody }, detail: { summary: 'The signed-in account, its plan, limits and usage this month' } },
);
