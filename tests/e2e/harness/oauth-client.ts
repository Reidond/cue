// The Mac app's sign-in as a Node program, for cases that check the backend itself (the token endpoints, revocation, what a client
// sees): Authorization Code + PKCE against the real Worker, following the redirects by hand, with a cookie jar standing in for the
// browser sheet. Cue's own client is CueAPI.swift; `CUE_WEB_AUTH=headless` does the same there.
import { createHash, randomBytes } from 'node:crypto';

export const CLIENT_ID = 'cue-mac';
export const REDIRECT_URI = 'com.andriishafar.cue:/oauth/callback';
export const AUDIENCE = 'https://api.cue.test';

export interface Tokens {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    expires_in: number;
}

/** How a sign-in ended: with a code for the token endpoint, or at the page that says the person isn't invited. */
export type SignInResult =
    | { kind: 'code'; code: string; verifier: string }
    | { kind: 'not_invited'; email: string | null }
    | { kind: 'failed'; detail: string };

const b64url = (bytes: Buffer) => bytes.toString('base64url');

export async function signInThroughBrowser(base: string, provider: 'google' | 'github' = 'google'): Promise<SignInResult> {
    const jar = new Map<string, string>();
    const remember = (response: Response) => {
        for (const line of response.headers.getSetCookie()) {
            const [pair = ''] = line.split(';');
            const eq = pair.indexOf('=');
            const name = pair.slice(0, eq),
                value = pair.slice(eq + 1);
            if (value === '' || /max-age=0/i.test(line)) jar.delete(name);
            else jar.set(name, value);
        }
    };
    const verifier = b64url(randomBytes(32));
    const url = new URL('/api/auth/oauth2/authorize', base);
    url.search = new URLSearchParams({
        response_type: 'code',
        client_id: CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        scope: 'openid profile email offline_access',
        state: b64url(randomBytes(12)),
        code_challenge: b64url(createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
        resource: AUDIENCE,
    }).toString();

    let next = url.toString();
    for (let hop = 0; hop < 15; hop++) {
        if (next.startsWith('com.andriishafar.cue:')) {
            const back = new URL(next);
            const code = back.searchParams.get('code');
            if (code) return { kind: 'code', code, verifier };
            return { kind: 'failed', detail: next };
        }
        const response = await fetch(next, {
            redirect: 'manual',
            headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), accept: 'text/html' },
        });
        remember(response);
        let location = response.headers.get('location');
        if (!location && (response.headers.get('content-type') ?? '').includes('json')) {
            // Without `Sec-Fetch-Mode: navigate` (which Node's fetch cannot send) the authorize endpoint answers with JSON.
            const json = (await response.clone().json()) as { redirect?: boolean; url?: string };
            if (json.redirect && json.url) location = json.url;
        }
        if (!location && new URL(next).pathname === '/login') {
            // The sign-in page: press the provider's button.
            const html = await response.text();
            const link = new RegExp(`href="(/login/${provider}\\?[^"]*)"`).exec(html)?.[1];
            if (!link) return { kind: 'failed', detail: `no ${provider} button on the sign-in page` };
            location = link.replaceAll('&amp;', '&').replaceAll('&#38;', '&');
        }
        if (!location) return { kind: 'failed', detail: `${response.status} ${(await response.text()).slice(0, 200)}` };
        if (location.startsWith('com.andriishafar.cue:')) {
            next = location;
            continue;
        }
        next = new URL(location, next).toString();
        const landed = new URL(next);
        if (landed.pathname === '/invite-only') return { kind: 'not_invited', email: landed.searchParams.get('email') };
        if (landed.pathname === '/sign-in-failed') return { kind: 'failed', detail: next };
    }
    return { kind: 'failed', detail: 'too many redirects' };
}

export interface TokenResult {
    status: number;
    body: Partial<Tokens> & { error?: string; error_description?: string };
}

async function postToken(base: string, params: Record<string, string>): Promise<TokenResult> {
    const response = await fetch(new URL('/api/auth/oauth2/token', base), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, resource: AUDIENCE, ...params }),
    });
    const text = await response.text();
    try {
        return { status: response.status, body: JSON.parse(text) as TokenResult['body'] };
    } catch {
        return { status: response.status, body: { error: text.slice(0, 200) } };
    }
}

export const exchangeCode = (base: string, code: string, verifier: string) =>
    postToken(base, { grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI, code_verifier: verifier });

export const refreshTokens = (base: string, refreshToken: string) =>
    postToken(base, { grant_type: 'refresh_token', refresh_token: refreshToken });

export async function revokeToken(base: string, token: string): Promise<number> {
    const response = await fetch(new URL('/api/auth/oauth2/revoke', base), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, token, token_type_hint: 'refresh_token' }),
    });
    return response.status;
}

/**
 * Signing in to the admin as a browser does it (`/login/PROVIDER?next=admin`, the provider's page, the callback): the session cookie of the
 * admin SPA's API, or why it did not come. A cookie jar stands in for the browser, as in `signInThroughBrowser`.
 */
export async function signInToAdmin(
    base: string,
    provider: 'google' | 'github' = 'google',
): Promise<{ kind: 'session'; cookie: string } | { kind: 'not_invited'; email: string | null } | { kind: 'failed'; detail: string }> {
    const jar = new Map<string, string>();
    let next = new URL(`/login/${provider}?next=admin`, base).toString();
    for (let hop = 0; hop < 15; hop++) {
        const response = await fetch(next, {
            redirect: 'manual',
            headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '), accept: 'text/html' },
        });
        for (const line of response.headers.getSetCookie()) {
            const [pair = ''] = line.split(';');
            const eq = pair.indexOf('=');
            const name = pair.slice(0, eq),
                value = pair.slice(eq + 1);
            if (value === '' || /max-age=0/i.test(line)) jar.delete(name);
            else jar.set(name, value);
        }
        const location = response.headers.get('location');
        if (!location) return { kind: 'failed', detail: `${response.status} ${(await response.text()).slice(0, 200)}` };
        next = new URL(location, next).toString();
        const landed = new URL(next);
        if (landed.pathname === '/invite-only') return { kind: 'not_invited', email: landed.searchParams.get('email') };
        if (landed.pathname === '/sign-in-failed') return { kind: 'failed', detail: next };
        if (landed.pathname.startsWith('/admin')) return { kind: 'session', cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') };
    }
    return { kind: 'failed', detail: 'too many redirects' };
}
