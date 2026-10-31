// The real Cue backend (apps/api) for one case: the Worker under `cf dev` with its own local D1 and KV, on its own port, next to the
// case's stand-ins for the outside world (Google and GitHub sign-in, and from PR 5 on Anthropic and Deepgram). A case has its own
// backend rather than sharing one with the run, so that what the backend calls upstream is exactly what that case's stand-ins answer,
// and cases stay independent and safe to run from several checkouts at once (see AGENTS.md › Testing).
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { E2E_ROOT } from './config.ts';
import { type FakeIdp, startFakeIdp } from './fake-idp.ts';
import { exchangeCode, refreshTokens, revokeToken, signInThroughBrowser, type SignInResult, type TokenResult } from './oauth-client.ts';
import { exec } from './process.ts';
import { fail } from './results.ts';
import { sleep, within } from './time.ts';

const API = join(E2E_ROOT, '..', '..', 'apps', 'api');
const CF = join(API, 'node_modules', '.bin', 'cf');
const DEV_DB_ID = '6a1c0e5b-3d6f-4f6e-9a57-2c1f8b7d4e90';

export interface BackendOptions {
    /** How long an access token lives, in seconds (production: 900). */
    accessTokenSeconds?: number;
    /** ADMIN_EMAILS: always invited, and the `admin` role. */
    adminEmails?: string[];
    /** More environment for the Worker: its upstreams' URLs (ANTHROPIC_URL, DEEPGRAM_URL) from the case's `fake-providers.ts`, and so on. */
    env?: Record<string, string>;
}

/** An unused TCP port, on 127.0.0.1. */
async function freePort(): Promise<number> {
    const { createServer } = await import('node:net');
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as { port: number };
            server.close(() => resolve(port));
        });
    });
}

export class Backend {
    /** The backend's origin, as the app is told it (CUE_API_URL) and as the OAuth issuer. */
    readonly url: string;
    readonly idp: FakeIdp;
    readonly log: string;
    readonly state: string;
    #child: ChildProcess;

    private constructor(url: string, idp: FakeIdp, log: string, state: string, child: ChildProcess) {
        this.url = url;
        this.idp = idp;
        this.log = log;
        this.state = state;
        this.#child = child;
    }

    /** Starts the backend with `dir` as its folder (database, logs) and waits until it answers. */
    static async start(dir: string, options: BackendOptions = {}): Promise<Backend> {
        const state = join(dir, 'backend-state');
        await mkdir(state, { recursive: true });
        const idp = await startFakeIdp();
        const port = await freePort();
        const url = `http://127.0.0.1:${port}`;
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            CI: '1',
            PORT: String(port),
            CUE_STATE_DIR: state,
            PUBLIC_URL: url,
            IDP_URL: idp.url,
            ACCESS_TOKEN_SECONDS: String(options.accessTokenSeconds ?? 900),
            ADMIN_EMAILS: (options.adminEmails ?? []).join(','),
            ...options.env,
        };
        delete env['NODE_TEST_CONTEXT'];

        const log = join(dir, 'backend.log');
        let backend: Backend | undefined;
        try {
            const migrated = await exec(CF, ['d1', 'migrations', 'apply', DEV_DB_ID, '--local', '--persist-to', state], {
                env,
                cwd: API,
                timeout: 120,
            });
            if (migrated.code !== 0) fail("the backend's migrations failed", migrated.output);

            const out = openSync(log, 'a');
            // Its own process group: `cf dev` leaves `cf-vite` and `workerd` behind when only it is killed.
            const child = spawn(CF, ['dev'], { cwd: API, env, stdio: ['ignore', out, out], detached: true });
            closeSync(out);
            backend = new Backend(url, idp, log, state, child);
            await backend.#waitUntilReady();
            return backend;
        } catch (error) {
            if (backend) await backend.stop();
            else await idp.close();
            throw error;
        }
    }

    async #waitUntilReady(): Promise<void> {
        // The first start of a checkout optimizes dependencies, which takes a while.
        const deadline = Date.now() + 180_000;
        for (;;) {
            if (this.#child.exitCode !== null) fail('the backend exited while starting', readFileSync(this.log, 'utf8').slice(-3000));
            const ready = await fetch(`${this.url}/`).then(
                (response) => response.ok,
                () => false,
            );
            if (ready) return;
            if (Date.now() > deadline) fail('the backend did not start in 180 s', readFileSync(this.log, 'utf8').slice(-3000));
            await sleep(0.3);
        }
    }

    async stop(): Promise<void> {
        const child = this.#child;
        if (child.pid !== undefined && child.exitCode === null) {
            const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
            try {
                process.kill(-child.pid, 'SIGTERM');
            } catch {
                /* already gone */
            }
            if (!(await within(exited, 8))) {
                try {
                    process.kill(-child.pid, 'SIGKILL');
                } catch {
                    /* already gone */
                }
            }
        }
        await this.idp.close();
    }

    // MARK: The owner's script

    async #invite(...args: string[]): Promise<void> {
        const ran = await exec(process.execPath, [join(API, 'scripts', 'invite.ts'), ...args], {
            env: { ...process.env, CI: '1', CUE_STATE_DIR: this.state },
            timeout: 60,
        });
        if (ran.code !== 0) fail(`invite ${args.join(' ')} failed`, ran.output);
    }

    /** Invites `email` (`pnpm --filter api invite EMAIL`). */
    invite(email: string): Promise<void> {
        return this.#invite(email);
    }

    /** Disables `email`: signed out everywhere, refused from now on (`invite EMAIL --disable`). */
    disable(email: string): Promise<void> {
        return this.#invite(email, '--disable');
    }

    // MARK: A client, for cases that check the backend itself

    /** The browser part of signing in as `email` with Google (or GitHub): the stand-in provider approves as them. */
    async signInAs(email: string, options: { provider?: 'google' | 'github'; verified?: boolean } = {}): Promise<SignInResult> {
        this.idp.approveAs(email, { verified: options.verified });
        return signInThroughBrowser(this.url, options.provider);
    }

    /** Signs `email` in (Authorization Code + PKCE) and returns the tokens; fails the case if the backend refuses. */
    async tokensFor(
        email: string,
        options: { provider?: 'google' | 'github' } = {},
    ): Promise<{ access_token: string; refresh_token: string }> {
        const result = await this.signInAs(email, options);
        if (result.kind !== 'code') return fail(`signing in as ${email} did not end in a code`, JSON.stringify(result));
        const exchanged = await exchangeCode(this.url, result.code, result.verifier);
        if (!exchanged.body.access_token || !exchanged.body.refresh_token) return fail('no tokens', JSON.stringify(exchanged));
        return { access_token: exchanged.body.access_token, refresh_token: exchanged.body.refresh_token };
    }

    refresh(refreshToken: string): Promise<TokenResult> {
        return refreshTokens(this.url, refreshToken);
    }

    revoke(token: string): Promise<number> {
        return revokeToken(this.url, token);
    }

    /** `GET path` with a bearer token (or none). */
    get(path: string, accessToken?: string): Promise<Response> {
        return fetch(new URL(path, this.url), { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });
    }
}
