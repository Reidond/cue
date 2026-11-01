import {
    AdminInvite,
    AdminInvites,
    AdminSession,
    AdminSettings,
    AdminUser,
    AdminUserDetail,
    AdminUsers,
    ApiError as ApiErrorBody,
    Done,
    InviteBody,
    LimitBody,
    MonthQuery,
    Overview,
    SettingsPatch,
    USERS_PAGE_SIZE,
    UsersQuery,
} from '@cue/contract';
import { env } from 'cloudflare:workers';
import { Elysia, t } from 'elysia';
import {
    addInvite,
    denylistKey,
    disableAccount,
    enableAccount,
    inviteState,
    LIST_INVITES,
    normalizeEmail,
    revokeInvite,
    type Statement,
} from '../accounts.ts';
import { adminEmails } from '../auth.ts';
import { authFor } from '../context.ts';
import { ApiError } from '../errors.ts';
import { readSettings, writeSettings } from '../settings.ts';
import { fillDays, monthOf, monthRange } from '../usage.ts';

// The owner's admin API (docs/backend.md › Admin API): same origin as the SPA, authorized by a Better Auth session cookie whose user has the
// `admin` role. It shows usage and money, never what anyone said.

const run = (statements: Statement[]) =>
    env.DB.batch(statements.map((statement) => env.DB.prepare(statement.sql).bind(...statement.params)));

/** The rows of one statement of a `batch`. */
const rowsOf = <Row>(result: D1Result | undefined) => (result?.results ?? []) as Row[];

const errors = { 401: ApiErrorBody, 403: ApiErrorBody };

/** Better Auth stores dates as ISO text (or milliseconds); either way, milliseconds since the epoch. */
function toMs(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return value;
    const parsed = Number.isFinite(Number(value)) ? Number(value) : Date.parse(`${value as string}`);
    return Number.isFinite(parsed) ? parsed : null;
}

interface UserRow {
    id: string;
    email: string;
    name: string;
    role: string | null;
    banned: number | null;
    created_at: unknown;
    micros: number;
    custom_limit: number | null;
    usage_at: number | null;
    session_at: unknown;
    token_at: unknown;
}

// `?` order: the month's `from` and `to` (the spend), then any `WHERE` the caller adds.
const USER_COLUMNS = `SELECT u.id AS id, u.email AS email, u.name AS name, u.role AS role, u.banned AS banned, u.createdAt AS created_at,
COALESCE((SELECT SUM(x.cost_micros) FROM usage x WHERE x.user_id = u.id AND x.created_at >= ? AND x.created_at < ?), 0) AS micros,
l.monthly_usd AS custom_limit,
(SELECT MAX(x.created_at) * 1000 FROM usage x WHERE x.user_id = u.id) AS usage_at,
(SELECT MAX(s.updatedAt) FROM session s WHERE s.userId = u.id) AS session_at,
(SELECT MAX(a.createdAt) FROM oauthAccessToken a WHERE a.userId = u.id) AS token_at
FROM user u LEFT JOIN user_limit l ON l.user_id = u.id`;

function userOf(row: UserRow, defaultLimitUsd: number): AdminUser {
    const seen = [row.usage_at, toMs(row.session_at), toMs(row.token_at)].filter((at): at is number => at !== null);
    return {
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role === 'admin' || adminEmails(env).includes(row.email.toLowerCase()) ? 'admin' : 'user',
        status: row.banned ? 'disabled' : 'active',
        usd: row.micros / 1e6,
        limitUsd: row.custom_limit ?? defaultLimitUsd,
        customLimit: row.custom_limit !== null,
        lastActiveAt: seen.length > 0 ? Math.max(...seen) : null,
        createdAt: toMs(row.created_at) ?? 0,
    };
}

async function findUser(id: string, month: string): Promise<AdminUser> {
    const { from, to } = monthRange(month);
    const [settings, row] = await Promise.all([
        readSettings(env.DB),
        env.DB.prepare(`${USER_COLUMNS} WHERE u.id = ?`).bind(from, to, id).first<UserRow>(),
    ]);
    if (!row) throw new ApiError('not_found', 'There is no such user.');
    return userOf(row, settings.defaultMonthlyLimitUsd);
}

async function invites() {
    const { results } = await env.DB.prepare(LIST_INVITES.sql).all<{
        email: string;
        disabled: number;
        created_at: number;
        user_id: string | null;
    }>();
    return results.map((row) => ({
        email: row.email,
        status: inviteState(row),
        createdAt: row.created_at * 1000,
        userId: row.user_id,
    }));
}

const monthOfQuery = (query: { month?: string }) => query.month ?? monthOf();

/** Admin API: overview, users, invites and settings. */
export const admin = new Elysia({ name: 'admin', prefix: '/admin/v1' })
    // A cookie is sent with any request the browser makes; a write must come from this origin (Better Auth's cookies are SameSite=Lax as well).
    .onBeforeHandle(({ request }) => {
        if (request.method !== 'GET' && request.headers.get('origin') !== new URL(env.PUBLIC_URL).origin) {
            throw new ApiError('forbidden', 'This request did not come from the admin.');
        }
    })
    .onAfterHandle(({ set }) => {
        set.headers['cache-control'] = 'no-store';
    })
    // Whoever has a session: the SPA asks who it is before it knows whether to show the admin or "not allowed".
    .resolve({ as: 'scoped' }, async ({ request }) => {
        const session = await authFor().api.getSession({ headers: request.headers });
        if (!session) throw new ApiError('unauthorized', 'Sign in to Cue.');
        const { user } = session;
        return {
            self: {
                id: user.id,
                email: user.email,
                name: user.name,
                role: user.role === 'admin' || adminEmails(env).includes(user.email.toLowerCase()) ? ('admin' as const) : ('user' as const),
            },
        };
    })
    .get('/session', ({ self }) => self, {
        response: { 200: AdminSession, 401: ApiErrorBody },
        detail: { summary: 'Who the session cookie belongs to (any signed-in account)' },
    })
    // Everything below is for the owner.
    .onBeforeHandle(({ self }) => {
        if (self.role !== 'admin') throw new ApiError('forbidden', 'This account is not allowed to use the admin.');
    })
    .get(
        '/overview',
        async ({ query }) => {
            const month = monthOfQuery(query);
            const { from, to } = monthRange(month);
            const { defaultMonthlyLimitUsd } = await readSettings(env.DB);
            const [days, features, spenders, limits, disabled] = await env.DB.batch([
                env.DB.prepare(
                    `SELECT date(created_at, 'unixepoch') AS day, SUM(cost_micros) AS micros FROM usage WHERE created_at >= ? AND created_at < ? GROUP BY day`,
                ).bind(from, to),
                env.DB.prepare(
                    `SELECT feature, SUM(cost_micros) AS micros FROM usage WHERE created_at >= ? AND created_at < ? GROUP BY feature ORDER BY micros DESC, feature`,
                ).bind(from, to),
                env.DB.prepare(
                    `SELECT u.id AS id, u.email AS email, u.name AS name, s.micros AS micros, COALESCE(l.monthly_usd, ?) AS limit_usd
FROM (SELECT user_id, SUM(cost_micros) AS micros FROM usage WHERE created_at >= ? AND created_at < ? GROUP BY user_id ORDER BY micros DESC LIMIT 10) s
JOIN user u ON u.id = s.user_id LEFT JOIN user_limit l ON l.user_id = u.id ORDER BY s.micros DESC, u.email`,
                ).bind(defaultMonthlyLimitUsd, from, to),
                env.DB.prepare(
                    `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(l.monthly_usd, ?)), 0) AS total
FROM user u LEFT JOIN user_limit l ON l.user_id = u.id WHERE COALESCE(u.banned, 0) = 0`,
                ).bind(defaultMonthlyLimitUsd),
                env.DB.prepare('SELECT COUNT(*) AS n FROM user WHERE banned = 1'),
            ]);
            const byDay = fillDays(month, new Map(rowsOf<{ day: string; micros: number }>(days).map((row) => [row.day, row.micros])));
            const counts = rowsOf<{ n: number; total: number }>(limits)[0]!;
            return {
                month,
                usd: byDay.reduce((sum, day) => sum + day.usd, 0),
                limitUsd: counts.total,
                users: { active: counts.n, disabled: rowsOf<{ n: number }>(disabled)[0]!.n },
                byDay,
                byFeature: rowsOf<{ feature: string; micros: number }>(features).map((row) => ({
                    feature: row.feature,
                    usd: row.micros / 1e6,
                })),
                byUser: rowsOf<{ id: string; email: string; name: string; micros: number; limit_usd: number }>(spenders).map((row) => ({
                    id: row.id,
                    email: row.email,
                    name: row.name,
                    usd: row.micros / 1e6,
                    limitUsd: row.limit_usd,
                })),
            };
        },
        {
            query: MonthQuery,
            response: { 200: Overview, ...errors },
            detail: { summary: 'Spend in a month: total against the limits, per day, per feature and the biggest spenders' },
        },
    )
    .get(
        '/users',
        async ({ query }) => {
            const month = monthOfQuery(query);
            const { from, to } = monthRange(month);
            const { defaultMonthlyLimitUsd } = await readSettings(env.DB);
            const { results } = await env.DB.prepare(USER_COLUMNS).bind(from, to).all<UserRow>();
            // The list is the owner's invite-only crowd, so filtering, sorting and paging happen here, over rows that carry everything.
            const needle = query.q?.trim().toLowerCase() ?? '';
            const status = query.status ?? 'all';
            const matching = results
                .map((row) => userOf(row, defaultMonthlyLimitUsd))
                .filter(
                    (user) => (status === 'all' || user.status === status) && `${user.email}\n${user.name}`.toLowerCase().includes(needle),
                );
            const sort = query.sort ?? 'recent';
            matching.sort((a, b) => {
                if (sort === 'spend') return b.usd - a.usd || a.email.localeCompare(b.email);
                if (sort === 'name') return a.email.localeCompare(b.email);
                return (b.lastActiveAt ?? -1) - (a.lastActiveAt ?? -1) || b.createdAt - a.createdAt || a.email.localeCompare(b.email);
            });
            const page = query.page ?? 1;
            return {
                users: matching.slice((page - 1) * USERS_PAGE_SIZE, page * USERS_PAGE_SIZE),
                total: matching.length,
                page,
                pageSize: USERS_PAGE_SIZE,
            };
        },
        {
            query: UsersQuery,
            response: { 200: AdminUsers, ...errors },
            detail: { summary: 'Users with their spend, limit and last activity' },
        },
    )
    .get(
        '/users/:id',
        async ({ params, query }) => {
            const month = monthOfQuery(query);
            const { from, to } = monthRange(month);
            const user = await findUser(params.id, month);
            const [days, features] = await env.DB.batch([
                env.DB.prepare(
                    `SELECT date(created_at, 'unixepoch') AS day, SUM(cost_micros) AS micros FROM usage WHERE user_id = ? AND created_at >= ? AND created_at < ? GROUP BY day`,
                ).bind(params.id, from, to),
                env.DB.prepare(
                    `SELECT feature, SUM(cost_micros) AS micros FROM usage WHERE user_id = ? AND created_at >= ? AND created_at < ? GROUP BY feature ORDER BY micros DESC, feature`,
                ).bind(params.id, from, to),
            ]);
            return {
                user,
                month,
                byDay: fillDays(month, new Map(rowsOf<{ day: string; micros: number }>(days).map((row) => [row.day, row.micros]))),
                byFeature: rowsOf<{ feature: string; micros: number }>(features).map((row) => ({
                    feature: row.feature,
                    usd: row.micros / 1e6,
                })),
            };
        },
        {
            params: t.Object({ id: t.String() }),
            query: MonthQuery,
            response: { 200: AdminUserDetail, ...errors, 404: ApiErrorBody },
            detail: { summary: 'One user: spend per day and per feature' },
        },
    )
    .post(
        '/users/:id/disable',
        async ({ params, self }) => {
            if (params.id === self.id) throw new ApiError('bad_request', 'You cannot disable your own account.');
            const user = await findUser(params.id, monthOf());
            await run(disableAccount(user.email.toLowerCase()));
            // The ban and the revoked tokens end the sessions; the denylist ends access tokens that are still valid, at once.
            await env.DENYLIST.put(denylistKey(user.id), '1');
            return findUser(params.id, monthOf());
        },
        {
            params: t.Object({ id: t.String() }),
            response: { 200: AdminUser, ...errors, 404: ApiErrorBody },
            detail: { summary: 'Disable a user: signed out everywhere, refused from now on' },
        },
    )
    .post(
        '/users/:id/enable',
        async ({ params }) => {
            const user = await findUser(params.id, monthOf());
            await run(enableAccount(user.email.toLowerCase()));
            await env.DENYLIST.delete(denylistKey(user.id));
            return findUser(params.id, monthOf());
        },
        {
            params: t.Object({ id: t.String() }),
            response: { 200: AdminUser, ...errors, 404: ApiErrorBody },
            detail: { summary: 'Let a disabled user back in' },
        },
    )
    .patch(
        '/users/:id/limit',
        async ({ params, body }) => {
            await findUser(params.id, monthOf());
            if (body.monthlyUsd === null) await env.DB.prepare('DELETE FROM user_limit WHERE user_id = ?').bind(params.id).run();
            else {
                await env.DB.prepare(
                    'INSERT INTO user_limit (user_id, monthly_usd) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET monthly_usd = excluded.monthly_usd',
                )
                    .bind(params.id, body.monthlyUsd)
                    .run();
            }
            return findUser(params.id, monthOf());
        },
        {
            params: t.Object({ id: t.String() }),
            body: LimitBody,
            response: { 200: AdminUser, ...errors, 404: ApiErrorBody },
            detail: { summary: "Change a user's monthly limit, or put them back on the default" },
        },
    )
    .get('/invites', async () => ({ invites: await invites() }), {
        response: { 200: AdminInvites, ...errors },
        detail: { summary: 'Invites: pending (not signed in yet), accepted and disabled' },
    })
    .post(
        '/invites',
        async ({ body }) => {
            const email = normalizeEmail(body.email);
            if (!email) throw new ApiError('bad_request', 'That is not an email address.');
            if ((await invites()).some((invite) => invite.email === email))
                throw new ApiError('bad_request', `${email} is already invited.`);
            await run(addInvite(email));
            return (await invites()).find((invite) => invite.email === email)!;
        },
        {
            body: InviteBody,
            response: { 200: AdminInvite, ...errors, 400: ApiErrorBody },
            detail: { summary: 'Invite an email address' },
        },
    )
    .delete(
        '/invites/:email',
        async ({ params }) => {
            const email = normalizeEmail(params.email);
            const invite = email ? (await invites()).find((candidate) => candidate.email === email) : undefined;
            if (!email || !invite) throw new ApiError('not_found', 'There is no such invite.');
            if (invite.status !== 'pending') throw new ApiError('bad_request', 'They have signed in already: disable them instead.');
            await run(revokeInvite(email));
            return { ok: true as const };
        },
        {
            params: t.Object({ email: t.String() }),
            response: { 200: Done, ...errors, 400: ApiErrorBody, 404: ApiErrorBody },
            detail: { summary: 'Withdraw an invite nobody has used yet' },
        },
    )
    .get('/settings', () => readSettings(env.DB), {
        response: { 200: AdminSettings, ...errors },
        detail: { summary: 'Default monthly limit, audio retention, whether the plan is paused' },
    })
    .patch(
        '/settings',
        async ({ body }) => {
            await writeSettings(env.DB, body);
            return readSettings(env.DB);
        },
        {
            body: SettingsPatch,
            response: { 200: AdminSettings, ...errors },
            detail: { summary: 'Change settings; pausing makes every /v1 route answer plan_paused' },
        },
    );
