import { createLocalJWKSet, type JSONWebKeySet, type JWTPayload, jwtVerify } from 'jose';
import { API_AUDIENCE, type Auth } from './auth.ts';
import { ApiError } from './errors.ts';

// The signing keys, per isolate: one D1 read (through Better Auth's /jwks) the first time, then none.
// An unknown `kid` (a rotated key) refreshes them once.
let cached: JSONWebKeySet | undefined;

async function jwks(auth: () => Auth, refresh = false): Promise<JSONWebKeySet> {
    if (!cached || refresh) cached = (await auth().api.getJwks()) as JSONWebKeySet;
    return cached;
}

async function verify(auth: () => Auth, issuer: string, token: string): Promise<JWTPayload> {
    const options = { issuer, audience: API_AUDIENCE, algorithms: ['EdDSA', 'ES256', 'RS256'] };
    try {
        return (await jwtVerify(token, createLocalJWKSet(await jwks(auth)), options)).payload;
    } catch (error) {
        if ((error as { code?: string }).code !== 'ERR_JWKS_NO_MATCHING_KEY') throw error;
        return (await jwtVerify(token, createLocalJWKSet(await jwks(auth, true)), options)).payload;
    }
}

/**
 * The user a request's bearer token belongs to: the signature, issuer, audience and expiry checked against the JWKS, and the
 * user checked against the denylist of disabled users. No D1 read on a warm isolate. `auth` is a factory so a warm isolate
 * never even builds the auth instance.
 */
export async function authenticate(request: Request, auth: () => Auth, issuer: string, denylist: KVNamespace): Promise<{ userId: string }> {
    const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) throw new ApiError('unauthorized', 'Sign in to Cue.');
    let claims: JWTPayload;
    try {
        claims = await verify(auth, issuer, token);
    } catch {
        throw new ApiError('unauthorized', 'Your session has ended. Sign in to Cue again.');
    }
    if (!claims.sub) throw new ApiError('unauthorized', 'Your session has ended. Sign in to Cue again.');
    if (await denylist.get(`disabled:${claims.sub}`)) throw new ApiError('unauthorized', 'This account has been disabled.');
    return { userId: claims.sub };
}
