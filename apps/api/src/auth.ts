import { oauthProvider } from '@better-auth/oauth-provider';
import { OAUTH } from '@cue/contract';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { admin, genericOAuth, jwt } from 'better-auth/plugins';

export const MAC_CLIENT_ID = OAUTH.macClientId;
export const API_AUDIENCE = OAUTH.audience;

export const PROVIDERS = ['google', 'github'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** What the Worker's bindings give the auth server. Nothing in this file may import `cloudflare:workers`, so the same config runs under Node (tools/gen-schema.ts). */
export interface AuthEnv {
    PUBLIC_URL: string;
    BETTER_AUTH_SECRET: string;
    ADMIN_EMAILS: string;
    ACCESS_TOKEN_SECONDS: string;
    GOOGLE_CLIENT_ID: string;
    GOOGLE_CLIENT_SECRET: string;
    GOOGLE_AUTHORIZE_URL: string;
    GOOGLE_TOKEN_URL: string;
    GOOGLE_USERINFO_URL: string;
    GITHUB_CLIENT_ID: string;
    GITHUB_CLIENT_SECRET: string;
    GITHUB_AUTHORIZE_URL: string;
    GITHUB_TOKEN_URL: string;
    GITHUB_USER_URL: string;
    GITHUB_EMAILS_URL: string;
}

export const adminEmails = (env: Pick<AuthEnv, 'ADMIN_EMAILS'>): string[] =>
    env.ADMIN_EMAILS.split(',')
        .map((email) => email.trim().toLowerCase())
        .filter(Boolean);

interface Profile {
    [key: string]: unknown;
    id: string;
    email: string;
    emailVerified: boolean;
    name: string;
    image?: string;
}

async function getJson(url: string, accessToken: string, headers: Record<string, string> = {}): Promise<unknown> {
    const res = await fetch(url, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json', 'user-agent': 'cue', ...headers },
    });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return res.json();
}

/** Google's OpenID Connect userinfo. */
async function googleProfile(env: AuthEnv, accessToken: string): Promise<Profile> {
    const info = (await getJson(env.GOOGLE_USERINFO_URL, accessToken)) as {
        sub: string;
        email?: string;
        email_verified?: boolean;
        name?: string;
        picture?: string;
    };
    const email = info.email ?? '';
    return {
        id: info.sub,
        email,
        emailVerified: info.email_verified === true,
        name: info.name ?? email.split('@')[0] ?? '',
        image: info.picture,
    };
}

/** GitHub is not OpenID Connect: the profile and the email addresses (with what GitHub verified) are separate calls. */
async function githubProfile(env: AuthEnv, accessToken: string): Promise<Profile> {
    const user = (await getJson(env.GITHUB_USER_URL, accessToken)) as {
        id: number | string;
        login: string;
        name?: string | null;
        avatar_url?: string;
    };
    const emails = (await getJson(env.GITHUB_EMAILS_URL, accessToken)) as { email: string; primary: boolean; verified: boolean }[];
    // The primary address if GitHub verified it, else any verified one: only an address GitHub vouches for may be matched to an invite.
    const chosen = emails.find((entry) => entry.primary && entry.verified) ?? emails.find((entry) => entry.verified);
    return {
        id: String(user.id),
        email: chosen?.email ?? emails.find((entry) => entry.primary)?.email ?? '',
        emailVerified: chosen !== undefined,
        name: user.name ?? user.login,
        image: user.avatar_url,
    };
}

// `database` is a D1 binding in the Worker, or a node:sqlite handle when generating the schema.
export function createAuth(env: AuthEnv, database: Parameters<typeof betterAuth>[0]['database']) {
    const admins = adminEmails(env);
    const profileOf = (provider: Provider) => async (tokens: { accessToken?: string }) => {
        if (!tokens.accessToken) return null;
        return provider === 'google' ? googleProfile(env, tokens.accessToken) : githubProfile(env, tokens.accessToken);
    };
    return betterAuth({
        baseURL: env.PUBLIC_URL,
        secret: env.BETTER_AUTH_SECRET,
        database,
        disabledPaths: ['/token'],
        // Each request builds its own instance, which would otherwise re-read the whole schema (~19 D1 statements) every time;
        // the deploy applies the migrations, so the Worker never needs to check them.
        advanced: { database: { validateSchema: false } },
        // The same person signing in with Google and with GitHub is one user: both vouch for the same email.
        account: { accountLinking: { enabled: true, trustedProviders: [...PROVIDERS] } },
        databaseHooks: {
            user: {
                create: {
                    // Invite-only: the identity provider must vouch for the email, and it must be on the list (or be the owner's).
                    before: async (user) => {
                        const email = user.email.toLowerCase();
                        const owner = admins.includes(email);
                        if (!user.emailVerified || !(owner || (await isInvited(database, email)))) {
                            // The sign-in callback turns this into the invite-only page, which tells the app whose email it was.
                            throw new APIError('FORBIDDEN', { message: `not_invited:${email}` });
                        }
                        return { data: { ...user, email, role: owner ? 'admin' : 'user' } };
                    },
                },
            },
        },
        plugins: [
            admin({ defaultRole: 'user', adminRoles: ['admin'] }),
            jwt({
                jwt: { issuer: env.PUBLIC_URL, audience: API_AUDIENCE, expirationTime: `${Number(env.ACCESS_TOKEN_SECONDS)}s` },
            }),
            genericOAuth({
                config: PROVIDERS.map((provider) => ({
                    providerId: provider,
                    clientId: provider === 'google' ? env.GOOGLE_CLIENT_ID : env.GITHUB_CLIENT_ID,
                    clientSecret: provider === 'google' ? env.GOOGLE_CLIENT_SECRET : env.GITHUB_CLIENT_SECRET,
                    authorizationUrl: provider === 'google' ? env.GOOGLE_AUTHORIZE_URL : env.GITHUB_AUTHORIZE_URL,
                    tokenUrl: provider === 'google' ? env.GOOGLE_TOKEN_URL : env.GITHUB_TOKEN_URL,
                    scopes: provider === 'google' ? ['openid', 'email', 'profile'] : ['read:user', 'user:email'],
                    pkce: true,
                    getUserInfo: profileOf(provider),
                    // With explicit endpoints (no discovery document) Better Auth derives the account id from `id`, and complains without this.
                    accountSubject: ({ profile }: { profile: unknown }) => String((profile as { id: string }).id),
                })),
            }),
            oauthProvider({
                loginPage: '/login',
                consentPage: '/consent',
                cachedTrustedClients: new Set([MAC_CLIENT_ID]),
                resources: [API_AUDIENCE],
                accessTokenExpiresIn: Number(env.ACCESS_TOKEN_SECONDS),
                refreshTokenExpiresIn: 60 * 24 * 60 * 60,
            }),
        ],
    });
}

export type Auth = ReturnType<typeof createAuth>;

async function isInvited(database: unknown, email: string): Promise<boolean> {
    // D1: `prepare(sql).bind(...).first()`; node:sqlite (schema generation only): `prepare(sql).get(...)`.
    const db = database as {
        prepare(sql: string): { bind?(...values: unknown[]): { first(): Promise<unknown> }; get?(...values: unknown[]): unknown };
    };
    const statement = db.prepare('SELECT 1 AS ok FROM invite WHERE email = ? AND disabled = 0');
    const row = statement.bind ? await statement.bind(email).first() : statement.get!(email);
    return Boolean(row);
}
