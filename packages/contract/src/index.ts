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
/**
 * The languages a person can choose to read Cue in (Settings › General › Languages): the code, and the name in English and in itself. With two
 * chosen, every answer and every note comes in both: the language spoken in the call, and the other one beside it.
 */
export const LANGUAGES = [
    { code: 'en', name: 'English', native: 'English' },
    { code: 'uk', name: 'Ukrainian', native: 'Українська' },
    { code: 'pl', name: 'Polish', native: 'Polski' },
    { code: 'de', name: 'German', native: 'Deutsch' },
    { code: 'fr', name: 'French', native: 'Français' },
    { code: 'es', name: 'Spanish', native: 'Español' },
    { code: 'it', name: 'Italian', native: 'Italiano' },
    { code: 'pt', name: 'Portuguese', native: 'Português' },
    { code: 'nl', name: 'Dutch', native: 'Nederlands' },
    { code: 'cs', name: 'Czech', native: 'Čeština' },
] as const;

export const LanguageCode = Type.Union(
    LANGUAGES.map((language) => Type.Literal(language.code)),
    { description: 'One of LANGUAGES' },
);

/** `PUT /v1/me/languages`: the person's languages, in order (none, one, or two). */
export const Languages = Type.Object({
    languages: Type.Array(LanguageCode, {
        maxItems: 2,
        uniqueItems: true,
        description: 'In order. Two: answers and notes in both. One or none: in the language the call is held in',
    }),
});
export type Languages = Static<typeof Languages>;

const accountSettings = {
    speakerName: Type.String({ maxLength: 200, description: 'What answers and notes call the person (empty: "the speaker", "You")' }),
    autoAnswer: Type.Boolean({ description: 'Answer the questions Cue notices by itself; off: they wait for Prepare Answer' }),
    micQuestions: Type.Boolean({ description: 'The microphone also hears the room: its lines can hold questions' }),
    summarize: Type.Boolean({ description: 'Write a summary (and a title) of each recorded call' }),
    keepAudio: Type.Boolean({ description: "Keep a call's audio with its notes; off: it is deleted once the notes are ready" }),
};

/**
 * The settings that are the person's, not a device's (Settings › General), kept in the account so every Cue they sign in to follows them; the
 * server uses them for calls and notes. Null: the account has none yet, and an app signing in sends its own once (`PATCH /v1/me/settings`);
 * until then the server goes by what a call or a note's request says, as the apps from before them send it.
 */
export const AccountSettings = Type.Object({
    speakerName: Type.Union([accountSettings.speakerName, Type.Null()]),
    autoAnswer: Type.Union([accountSettings.autoAnswer, Type.Null()]),
    micQuestions: Type.Union([accountSettings.micQuestions, Type.Null()]),
    summarize: Type.Union([accountSettings.summarize, Type.Null()]),
    keepAudio: Type.Union([accountSettings.keepAudio, Type.Null()]),
});
export type AccountSettings = Static<typeof AccountSettings>;

/** `PATCH /v1/me/settings`: the settings to change; the others stay as they are. */
export const AccountSettingsPatch = Type.Partial(Type.Object(accountSettings), { minProperties: 1 });
export type AccountSettingsPatch = Static<typeof AccountSettingsPatch>;

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
    languages: Type.Array(Type.String(), { description: 'The languages the person reads Cue in, in order (see Languages)' }),
    settings: AccountSettings,
    limits: Type.Object({
        monthlyUsd: Type.Union([Type.Number(), Type.Null()], {
            description: 'The monthly spend limit in US dollars that applies to this account',
        }),
    }),
    usage: Type.Object({
        month: Type.String({ description: 'UTC month, YYYY-MM' }),
        usd: Type.Number({ description: 'What this month has cost so far, in US dollars' }),
        audioSeconds: Type.Number(),
        limitReached: Type.Boolean({
            description: 'usd has reached the limit: nothing that costs money starts until the month turns or the limit is raised',
        }),
        byFeature: Type.Array(Type.Object({ feature: Type.String(), usd: Type.Number() }), {
            description:
                'usd by feature (answer, question_judge, live_transcript, note_transcript, note_names, notes_summary, material_text), dearest first',
        }),
        periodStart: Type.Number({ description: 'Start of the billing period (the UTC month), milliseconds since the epoch' }),
        periodEnd: Type.Number({ description: "When it starts over: the next period's start, milliseconds since the epoch" }),
    }),
});
export type Me = Static<typeof Me>;

/** The OAuth clients (Cue for Mac, Cue for Windows) and the API audience. */
export const OAUTH = {
    macClientId: 'cue-mac',
    macRedirectUri: 'com.andriishafar.cue:/oauth/callback',
    // The Windows app signs in through the system browser and a loopback redirect (RFC 8252 §7.3): registered without a port, used with the one
    // the system gave the app (`http://127.0.0.1:PORT/oauth/callback`).
    windowsClientId: 'cue-windows',
    windowsRedirectUri: 'http://127.0.0.1/oauth/callback',
    // An identifier (RFC 8707 `resource`, the access token's `aud`), never fetched: `.test` never resolves.
    audience: 'https://api.cue.test',
    scope: 'openid profile email offline_access',
} as const;

export { Role } from './role.ts';
export * from './admin.ts';
export * from './projects.ts';
export * from './calls.ts';
export * from './notes.ts';
