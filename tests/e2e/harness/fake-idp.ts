// A stand-in for Google's and GitHub's sign-in, served on 127.0.0.1 from the case's own process. The backend reaches it through its
// IDP_URL (apps/api/cloudflare.config.ts), which repoints every endpoint it calls at these:
//
//   /google/authorize  /google/token  /google/userinfo                         OpenID Connect, as Google has it
//   /github/authorize  /github/token  /github/user  /github/user/emails        OAuth 2, as GitHub has it (email only in /user/emails)
//
// There is no sign-in page: `/authorize` approves at once, as the person `approveAs` chose (a real provider would ask them), so a case
// says who signs in and whether the provider has verified their email. Both providers check the PKCE verifier the backend sends.
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type IdpProvider = 'google' | 'github';

interface Identity {
    email: string;
    /** Whether the provider vouches for the email. */
    verified: boolean;
}

export interface FakeIdp {
    /** IDP_URL for the backend. */
    url: string;
    /** Who signs in from now on: the next `/authorize` of either provider approves as them. */
    approveAs(email: string, options?: { verified?: boolean }): void;
    /** Every request the backend and the browser made, oldest first, as `provider /path`. */
    readonly requests: string[];
    close(): Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let text = '';
        request.setEncoding('utf8');
        request.on('data', (chunk: string) => (text += chunk));
        request.on('end', () => resolve(text));
        request.on('error', reject);
    });
}

function send(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
}

/** A stable id for an email, as a provider's user id would be. */
const idOf = (email: string) => createHash('sha256').update(email).digest('hex').slice(0, 21);

export async function startFakeIdp(): Promise<FakeIdp> {
    let current: Identity = { email: 'nobody@example.com', verified: true };
    const codes = new Map<string, { identity: Identity; challenge: string | null }>();
    const tokens = new Map<string, Identity>();
    const requests: string[] = [];

    const server = createServer((request, response) => {
        void (async () => {
            const url = new URL(request.url ?? '/', 'http://127.0.0.1');
            const [, provider, ...rest] = url.pathname.split('/');
            const endpoint = `/${rest.join('/')}`;
            requests.push(`${provider} ${url.pathname}`);
            if (provider !== 'google' && provider !== 'github') return send(response, 404, { error: 'not_found' });

            if (endpoint === '/authorize') {
                const redirect = url.searchParams.get('redirect_uri');
                if (!redirect) return send(response, 400, { error: 'invalid_request' });
                const code = randomUUID();
                codes.set(code, { identity: current, challenge: url.searchParams.get('code_challenge') });
                const back = new URL(redirect);
                back.searchParams.set('code', code);
                back.searchParams.set('state', url.searchParams.get('state') ?? '');
                response.writeHead(302, { location: back.toString() });
                return response.end();
            }

            if (endpoint === '/token' && request.method === 'POST') {
                const form = new URLSearchParams(await readBody(request));
                const entry = codes.get(form.get('code') ?? '');
                const verifier = form.get('code_verifier');
                const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : null;
                if (!entry || (entry.challenge && entry.challenge !== challenge)) return send(response, 400, { error: 'invalid_grant' });
                codes.delete(form.get('code') ?? '');
                const token = randomUUID();
                tokens.set(token, entry.identity);
                return send(response, 200, { access_token: token, token_type: 'bearer', expires_in: 3600, scope: 'openid email profile' });
            }

            const identity = tokens.get((request.headers.authorization ?? '').replace(/^Bearer /i, ''));
            if (!identity) return send(response, 401, { error: 'invalid_token' });
            const name = identity.email.split('@')[0] ?? identity.email;
            if (provider === 'google' && endpoint === '/userinfo') {
                return send(response, 200, { sub: idOf(identity.email), email: identity.email, email_verified: identity.verified, name });
            }
            if (provider === 'github' && endpoint === '/user') {
                // GitHub's profile has no email field the backend may trust; /user/emails says which ones GitHub verified.
                return send(response, 200, { id: Number.parseInt(idOf(identity.email).slice(0, 8), 16), login: name, name });
            }
            if (provider === 'github' && endpoint === '/user/emails') {
                return send(response, 200, [{ email: identity.email, primary: true, verified: identity.verified }]);
            }
            return send(response, 404, { error: 'not_found' });
        })().catch((error: unknown) => send(response, 500, { error: String(error) }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        approveAs(email, options = {}) {
            current = { email: email.toLowerCase(), verified: options.verified ?? true };
        },
        requests,
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}
