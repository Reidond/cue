import { type Static, Type } from '@sinclair/typebox';
import { Role } from './role.ts';

// The admin API (`/admin/v1/*`, docs/backend.md): what the owner's admin SPA reads and writes. Usage and money only: never a transcript
// or a note. Money is US dollars (the database keeps millionths of a dollar); times are milliseconds since the epoch.

const Month = Type.String({ pattern: '^\\d{4}-(0[1-9]|1[0-2])$', description: 'UTC month, YYYY-MM' });

/** `?month=` of the reports; the current UTC month when left out. */
export const MonthQuery = Type.Object({ month: Type.Optional(Month) });

export const AdminSession = Type.Object({
    id: Type.String(),
    email: Type.String(),
    name: Type.String(),
    role: Role,
});
export type AdminSession = Static<typeof AdminSession>;

export const UserStatus = Type.Union([Type.Literal('active'), Type.Literal('disabled')]);
export type UserStatus = Static<typeof UserStatus>;

export const DayUsage = Type.Object({ date: Type.String({ description: 'UTC day, YYYY-MM-DD' }), usd: Type.Number() });
export type DayUsage = Static<typeof DayUsage>;

export const FeatureUsage = Type.Object({ feature: Type.String(), usd: Type.Number() });
export type FeatureUsage = Static<typeof FeatureUsage>;

export const AdminUser = Type.Object({
    id: Type.String(),
    email: Type.String(),
    name: Type.String(),
    role: Role,
    status: UserStatus,
    usd: Type.Number({ description: 'Spent in the month asked for' }),
    limitUsd: Type.Number({ description: 'The monthly limit that applies: their own, or the default' }),
    customLimit: Type.Boolean({ description: 'Whether limitUsd was set for this person (else the default applies)' }),
    lastActiveAt: Type.Union([Type.Number(), Type.Null()]),
    createdAt: Type.Number(),
});
export type AdminUser = Static<typeof AdminUser>;

export const AdminUserDetail = Type.Object({
    user: AdminUser,
    month: Month,
    byDay: Type.Array(DayUsage, { description: 'Every day of the month, zero-filled' }),
    byFeature: Type.Array(FeatureUsage),
});
export type AdminUserDetail = Static<typeof AdminUserDetail>;

export const UsersQuery = Type.Object({
    q: Type.Optional(Type.String({ maxLength: 200 })),
    status: Type.Optional(Type.Union([Type.Literal('all'), Type.Literal('active'), Type.Literal('disabled')])),
    sort: Type.Optional(Type.Union([Type.Literal('recent'), Type.Literal('spend'), Type.Literal('name')])),
    page: Type.Optional(Type.Integer({ minimum: 1 })),
    month: Type.Optional(Month),
});

export const USERS_PAGE_SIZE = 20;
export const AdminUsers = Type.Object({
    users: Type.Array(AdminUser),
    total: Type.Integer(),
    page: Type.Integer(),
    pageSize: Type.Integer(),
});
export type AdminUsers = Static<typeof AdminUsers>;

export const LimitBody = Type.Object({
    monthlyUsd: Type.Union([Type.Number({ minimum: 0, maximum: 100000 }), Type.Null()], {
        description: 'The new monthly limit in US dollars; null: back to the default',
    }),
});

export const Overview = Type.Object({
    month: Month,
    usd: Type.Number({ description: 'Spent this month by everyone' }),
    limitUsd: Type.Number({ description: 'The sum of the limits of everyone who is not disabled' }),
    users: Type.Object({ active: Type.Integer(), disabled: Type.Integer() }),
    byDay: Type.Array(DayUsage, { description: 'Every day of the month, zero-filled' }),
    byFeature: Type.Array(FeatureUsage),
    byUser: Type.Array(
        Type.Object({
            id: Type.String(),
            email: Type.String(),
            name: Type.String(),
            usd: Type.Number(),
            limitUsd: Type.Number(),
        }),
        { description: 'Who spent the most, at most ten' },
    ),
});
export type Overview = Static<typeof Overview>;

export const InviteStatus = Type.Union([Type.Literal('pending'), Type.Literal('accepted'), Type.Literal('disabled')]);
export type InviteStatus = Static<typeof InviteStatus>;

export const AdminInvite = Type.Object({
    email: Type.String(),
    status: InviteStatus,
    createdAt: Type.Number(),
    userId: Type.Union([Type.String(), Type.Null()], { description: 'Who signed in with it, once they have' }),
});
export type AdminInvite = Static<typeof AdminInvite>;

export const AdminInvites = Type.Object({ invites: Type.Array(AdminInvite) });
export type AdminInvites = Static<typeof AdminInvites>;

export const InviteBody = Type.Object({ email: Type.String({ maxLength: 254 }) });

export const AdminSettings = Type.Object({
    defaultMonthlyLimitUsd: Type.Number({ minimum: 0, maximum: 100000 }),
    audioRetentionDays: Type.Integer({
        minimum: 1,
        maximum: 3650,
        description: 'Days a recording stays in storage once its notes are ready',
    }),
    planPaused: Type.Boolean({ description: 'While true every /v1 route answers plan_paused' }),
});
export type AdminSettings = Static<typeof AdminSettings>;

export const SettingsPatch = Type.Partial(AdminSettings);

/** What a toggle or a delete answers. */
export const Done = Type.Object({ ok: Type.Literal(true) });
