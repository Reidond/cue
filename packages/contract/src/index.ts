import { type Static, Type } from '@sinclair/typebox';
import { Role } from './role.ts';

// The Cue API v1 (docs/backend.md): every client, the Mac app now and the Windows one later, speaks these shapes.
// Elysia validates and documents (OpenAPI) with them; the Swift `Codable` types in apps/mac follow them by hand.

export const ErrorCode = Type.Union(
    [
        Type.Literal('unauthorized'),
        Type.Literal('forbidden'),
        Type.Literal('not_invited'),
        Type.Literal('not_found'),
        Type.Literal('bad_request'),
        Type.Literal('limit_reached'),
        Type.Literal('rate_limited'),
        Type.Literal('upstream_unavailable'),
        Type.Literal('upgrade_required'),
        Type.Literal('plan_paused'),
        Type.Literal('internal'),
    ],
    {
        description:
            'unauthorized 401, forbidden 403, not_invited 403, limit_reached 402, rate_limited 429, upgrade_required 426, plan_paused 503',
    },
);
export type ErrorCode = Static<typeof ErrorCode>;

/** Every error body: `{error: {code, message, retryable}}`. */
export const ApiError = Type.Object({
    error: Type.Object({
        code: ErrorCode,
        message: Type.String(),
        retryable: Type.Boolean({ description: 'Whether the same request may succeed if sent again later' }),
    }),
});
export type ApiError = Static<typeof ApiError>;

/** The HTTP status each error code is sent with. */
export const errorStatus: Record<ErrorCode, number> = {
    unauthorized: 401,
    forbidden: 403,
    not_invited: 403,
    not_found: 404,
    bad_request: 400,
    limit_reached: 402,
    rate_limited: 429,
    upstream_unavailable: 502,
    upgrade_required: 426,
    plan_paused: 503,
    internal: 500,
};

/** `GET /v1/me`: who is signed in, on which plan, within which limits, having used how much this month. */
export const Me = Type.Object({
    account: Type.Object({
        id: Type.String(),
        email: Type.String(),
        name: Type.String(),
        role: Role,
    }),
    plan: Type.Object({
        id: Type.Literal('cue'),
        name: Type.String(),
    }),
    limits: Type.Object({
        monthlyUsd: Type.Union([Type.Number(), Type.Null()], {
            description: 'The monthly spend limit in US dollars that applies to this account',
        }),
    }),
    usage: Type.Object({
        month: Type.String({ description: 'UTC month, YYYY-MM' }),
        usd: Type.Number(),
        audioSeconds: Type.Number(),
    }),
});
export type Me = Static<typeof Me>;

/** The OAuth client and API audience of the Mac app (the Windows client gets its own rows). */
export const OAUTH = {
    macClientId: 'cue-mac',
    macRedirectUri: 'com.andriishafar.cue:/oauth/callback',
    // An identifier (RFC 8707 `resource`, the access token's `aud`), never fetched: `.test` never resolves.
    audience: 'https://api.cue.test',
    scope: 'openid profile email offline_access',
} as const;

export { Role } from './role.ts';
export * from './admin.ts';
export * from './projects.ts';
export * from './calls.ts';
