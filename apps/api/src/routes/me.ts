import { AccountSettings, ApiError as ApiErrorBody, Languages, Me, AccountSettingsPatch } from '@cue/contract';
import { env } from 'cloudflare:workers';
import { Elysia } from 'elysia';
import { adminEmails } from '../auth.ts';
import { ApiError } from '../errors.ts';
import { callOf } from '../call/stub.ts';
import { languagesOf, setLanguages } from '../languages.ts';
import { saveSettings, settingsOf } from '../preferences.ts';
import { accountUsage, monthOf } from '../usage.ts';
import { authed } from './authed.ts';

/** The signed-in account, and what the person keeps in it: the languages they read Cue in, and their settings. */
export const me = new Elysia({ name: 'me' })
    .use(authed)
    .get(
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
                    role:
                        user.role === 'admin' || adminEmails(env).includes(user.email.toLowerCase())
                            ? ('admin' as const)
                            : ('user' as const),
                },
                plan: { id: 'cue' as const, name: 'Cue' },
                languages: await languagesOf(env.DB, userId),
                settings: await settingsOf(env.DB, userId),
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
        {
            response: { 200: Me, 401: ApiErrorBody, 429: ApiErrorBody },
            detail: { summary: 'The signed-in account, its plan, limits and usage this month' },
        },
    )
    .put(
        '/me/languages',
        async ({ userId, body }) => {
            await setLanguages(env.DB, userId, body.languages);
            return { languages: body.languages };
        },
        {
            body: Languages,
            response: { 200: Languages, 400: ApiErrorBody, 401: ApiErrorBody, 429: ApiErrorBody },
            detail: { summary: 'The languages the person reads Cue in: two, and answers and notes come in both' },
        },
    )
    .patch(
        '/me/settings',
        async ({ userId, body }) => {
            const settings = await saveSettings(env.DB, userId, body);
            // The person's calls under way follow them at once, whichever device they are on.
            const { results } = await env.DB.prepare('SELECT id FROM call WHERE user_id = ? AND ended_at IS NULL')
                .bind(userId)
                .all<{ id: string }>();
            await Promise.allSettled(results.map((call) => callOf(call.id).settingsChanged(settings)));
            return settings;
        },
        {
            body: AccountSettingsPatch,
            response: { 200: AccountSettings, 400: ApiErrorBody, 401: ApiErrorBody, 429: ApiErrorBody },
            detail: {
                summary: "Changes the person's settings (the ones named): every app they use, and their calls under way, follow them",
            },
        },
    );
