// The real Cue backend (apps/api) for one case: the Worker under `cf dev` with its own local D1 and KV, on its own port, next to the
// case's stand-ins for the outside world (Google and GitHub sign-in, and from PR 5 on Anthropic and Deepgram). A case has its own
// backend rather than sharing one with the run, so that what the backend calls upstream is exactly what that case's stand-ins answer,
// and cases stay independent and safe to run from several checkouts at once (see AGENTS.md › Testing).
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, extname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Note } from '../../../packages/contract/src/notes.ts';
import { cfBin, cfBinOf, cfEnv } from '../../../apps/api/scripts/cf.ts';
import { E2E_ROOT } from './config.ts';
import { type FakeIdp, startFakeIdp } from './fake-idp.ts';
import {
    exchangeCode,
    MAC_CLIENT,
    type OAuthClient,
    refreshTokens,
    revokeToken,
    signInThroughBrowser,
    signInToAdmin,
    type SignInResult,
    type TokenResult,
    WINDOWS_CLIENT,
} from './oauth-client.ts';
import { exec, killTree, type Ran } from './process.ts';
import { fail } from './results.ts';
import { sleep, within } from './time.ts';

const API = join(E2E_ROOT, '..', '..', 'apps', 'api');
const ADMIN = join(E2E_ROOT, '..', '..', 'apps', 'admin');
// `cf` and `vp` are Node scripts: run by node itself (with the NODE_PATH pnpm's shims would add: scripts/cf.ts), so the same on Windows, where a
// package manager's shims are .cmd files.
const CF = [process.execPath, cfBin] as const;
const VP = [process.execPath, join(E2E_ROOT, '..', '..', 'node_modules', 'vite-plus', 'bin', 'vp')] as const;
const CONTENT_TYPES: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
};
const DEV_DB_ID = '6a1c0e5b-3d6f-4f6e-9a57-2c1f8b7d4e90';

/** Which app signs in: the Mac's client (the default), the Windows one, or any client by its id and redirect URI. */
export type ClientName = 'mac' | 'windows';

export interface SignInOptions {
    provider?: 'google' | 'github';
    verified?: boolean;
    client?: ClientName | OAuthClient;
    /** A sign-in that ends at the invite-only page reports its HTML (`page`). */
    readPages?: boolean;
}

function clientOf(client: ClientName | OAuthClient = 'mac'): OAuthClient {
    return client === 'mac' ? MAC_CLIENT : client === 'windows' ? WINDOWS_CLIENT : client;
}

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

/** Runs `command` detached (its own process group: `cf dev` leaves `cf-vite` and `workerd` behind when only it is killed), its output in `log`. */
function spawnLogged(command: readonly string[], cwd: string, env: NodeJS.ProcessEnv, log: string): ChildProcess {
    const out = openSync(log, 'a');
    const [file = '', ...args] = command;
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', out, out], detached: true, windowsHide: true });
    closeSync(out);
    return child;
}

/** A dev server of the case (the backend's Worker, the admin's), on its own port, its output in `log`. */
class DevServer {
    readonly url: string;
    readonly log: string;
    readonly #what: string;
    readonly #spawn: () => ChildProcess;
    #child: ChildProcess;
    #stopping = false;
    #restarts = 0;

    constructor(what: string, url: string, log: string, spawnChild: () => ChildProcess) {
        this.#what = what;
        this.url = url;
        this.log = log;
        this.#spawn = spawnChild;
        this.#child = this.#launch();
    }

    /**
     * Starts the process. Vite+ now and then panics, as it starts or a little later as it bundles dependencies ("entered unreachable code", a bug
     * of its own, seen on CI's Windows runners): the process is started again then, on the same port and state, twice at most.
     */
    #launch(): ChildProcess {
        const before = statSync(this.log, { throwIfNoEntry: false })?.size ?? 0;
        const child = this.#spawn();
        child.once('exit', () => {
            if (this.#stopping || this.#restarts >= 2 || !/Vite\+ panicked/.test(readFileSync(this.log, 'utf8').slice(before))) return;
            this.#restarts++;
            this.#child = this.#launch();
        });
        return child;
    }

    async waitUntilReady(): Promise<void> {
        // The first start of a checkout optimizes dependencies, which takes a while.
        const deadline = Date.now() + 180_000;
        for (;;) {
            // A process that panicked is started again (#launch): a moment for that before giving up.
            if (this.#child.exitCode !== null) await sleep(1);
            if (this.#child.exitCode !== null) fail(`${this.#what} exited while starting`, readFileSync(this.log, 'utf8').slice(-3000));
            const ready = await fetch(`${this.url}/`).then(
                (response) => response.ok,
                () => false,
            );
            if (ready) return;
            if (Date.now() > deadline) fail(`${this.#what} did not start in 180 s`, readFileSync(this.log, 'utf8').slice(-3000));
            await sleep(0.3);
        }
    }

    async stop(): Promise<void> {
        this.#stopping = true;
        const child = this.#child;
        if (child.pid !== undefined && child.exitCode === null) {
            const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
            await killTree(child, false);
            if (!(await within(exited, 8))) await killTree(child, true);
        }
    }
}

export class Backend {
    /** The backend's origin, as the app is told it (CUE_API_URL) and as the OAuth issuer. */
    readonly url: string;
    /** The admin SPA's origin (the backend's `ADMIN_URL`), whether or not the case has started it (`admin()`). */
    readonly adminUrl: string;
    readonly idp: FakeIdp;
    readonly log: string;
    readonly state: string;
    readonly #dir: string;
    readonly #server: DevServer;
    #admin: DevServer | undefined;
    #adminReady: Promise<void> | undefined;

    private constructor(dir: string, server: DevServer, adminUrl: string, idp: FakeIdp, state: string) {
        this.#dir = dir;
        this.#server = server;
        this.url = server.url;
        this.log = server.log;
        this.adminUrl = adminUrl;
        this.idp = idp;
        this.state = state;
    }

    /** Starts the backend with `dir` as its folder (database, logs) and waits until it answers. */
    static async start(dir: string, options: BackendOptions = {}): Promise<Backend> {
        const state = join(dir, 'backend-state');
        await mkdir(state, { recursive: true });
        const idp = await startFakeIdp();
        const port = await freePort();
        const url = `http://127.0.0.1:${port}`;
        // The admin's port is chosen now, as the backend must know its origin; its server starts only if the case opens it.
        const adminUrl = `http://127.0.0.1:${await freePort()}`;
        const env: NodeJS.ProcessEnv = {
            ...cfEnv(),
            PORT: String(port),
            CUE_STATE_DIR: state,
            PUBLIC_URL: url,
            ADMIN_URL: adminUrl,
            IDP_URL: idp.url,
            ACCESS_TOKEN_SECONDS: String(options.accessTokenSeconds ?? 900),
            ADMIN_EMAILS: (options.adminEmails ?? []).join(','),
            ...options.env,
        };
        delete env['NODE_TEST_CONTEXT'];

        const log = join(dir, 'backend.log');
        let backend: Backend | undefined;
        try {
            const migrated = await exec(CF[0], [CF[1], 'd1', 'migrations', 'apply', DEV_DB_ID, '--local', '--persist-to', state], {
                env,
                cwd: API,
                timeout: 120,
            });
            if (migrated.code !== 0) fail("the backend's migrations failed", migrated.output);

            // E2E_BACKEND=preview runs the compiled Worker (`cf build --mode development`, served by `vp preview`) instead of `cf dev`: Elysia
            // compiles its routes ahead of time there, as in production, and under `cf dev` it does not (AGENTS.md › The backend).
            const preview = process.env['E2E_BACKEND'] === 'preview';
            if (preview) {
                const built = await exec(CF[0], [CF[1], 'build', '--mode', 'development'], { env, cwd: API, timeout: 300 });
                if (built.code !== 0) fail('building the backend failed', built.output);
            }
            const command = preview ? [...VP, 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'] : [...CF, 'dev'];
            backend = new Backend(
                dir,
                new DevServer('the backend', url, log, () => spawnLogged(command, API, env, log)),
                adminUrl,
                idp,
                state,
            );
            await backend.#server.waitUntilReady();
            return backend;
        } catch (error) {
            if (backend) await backend.stop();
            else await idp.close();
            throw error;
        }
    }

    /**
     * Starts the admin SPA (apps/admin under `cf dev`, a Worker of its own as in production) at `adminUrl`, talking to this backend, the first
     * time a case asks for it; returns its origin once it answers.
     */
    async admin(): Promise<string> {
        if (!this.#adminReady) {
            const log = join(this.#dir, 'admin.log');
            const env = cfEnv({ PORT: new URL(this.adminUrl).port, CUE_API_URL: this.url }, 'admin');
            delete env['NODE_TEST_CONTEXT'];
            this.#admin = new DevServer('the admin', this.adminUrl, log, () =>
                spawnLogged([process.execPath, cfBinOf('admin'), 'dev'], ADMIN, env, log),
            );
            this.#adminReady = this.#admin.waitUntilReady();
        }
        await this.#adminReady;
        return this.adminUrl;
    }

    async stop(): Promise<void> {
        await this.#admin?.stop();
        await this.#server.stop();
        await this.idp.close();
    }

    // MARK: The owner's script

    async #invite(...args: string[]): Promise<void> {
        for (let attempt = 0; ; attempt++) {
            const ran = await exec(process.execPath, [join(API, 'scripts', 'invite.ts'), ...args], {
                env: { ...process.env, CI: '1', CUE_STATE_DIR: this.state },
                timeout: 60,
            });
            if (ran.code === 0) return;
            // `cf d1 raw` asks Cloudflare's API even for the local database, which now and then answers 500 (see #d1): tried again.
            if (attempt >= 5 || !/session commit token|500 Internal Server Error/i.test(ran.output))
                fail(`invite ${args.join(' ')} failed`, ran.output);
            await sleep(2 * (attempt + 1));
        }
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
    async signInAs(email: string, options: SignInOptions = {}): Promise<SignInResult> {
        this.idp.approveAs(email, { verified: options.verified });
        return signInThroughBrowser(this.url, options.provider, clientOf(options.client), { readPages: options.readPages });
    }

    /** Signs `email` in (Authorization Code + PKCE) and returns the tokens; fails the case if the backend refuses. */
    async tokensFor(email: string, options: SignInOptions = {}): Promise<{ access_token: string; refresh_token: string }> {
        const result = await this.signInAs(email, options);
        if (result.kind !== 'code') return fail(`signing in as ${email} did not end in a code`, JSON.stringify(result));
        const exchanged = await exchangeCode(this.url, result.code, result.verifier, clientOf(options.client));
        if (!exchanged.body.access_token || !exchanged.body.refresh_token) return fail('no tokens', JSON.stringify(exchanged));
        return { access_token: exchanged.body.access_token, refresh_token: exchanged.body.refresh_token };
    }

    refresh(refreshToken: string, client?: ClientName | OAuthClient): Promise<TokenResult> {
        return refreshTokens(this.url, refreshToken, clientOf(client));
    }

    revoke(token: string, client?: ClientName | OAuthClient): Promise<number> {
        return revokeToken(this.url, token, clientOf(client));
    }

    /** `GET path` with a bearer token (or none). */
    get(path: string, accessToken?: string): Promise<Response> {
        return fetch(new URL(path, this.url), { headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {} });
    }

    /**
     * The Cue API with a bearer token: `method path`, a JSON `body` or the `file` as the body (its name in `?name=`, its type from the name,
     * as the app uploads a material). Returns the status and the parsed JSON (or the text).
     */
    async call(
        method: string,
        path: string,
        accessToken: string,
        options: { body?: unknown; file?: { path: string; name?: string; contentType?: string } } = {},
    ): Promise<{ status: number; body: any }> {
        const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
        let payload: Buffer | string | undefined;
        let url = path;
        if (options.file) {
            const bytes = readFileSync(options.file.path);
            const name = options.file.name ?? basename(options.file.path);
            headers['content-type'] = options.file.contentType ?? CONTENT_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream';
            payload = bytes;
            url += `${path.includes('?') ? '&' : '?'}name=${encodeURIComponent(name)}`;
        } else if (options.body !== undefined) {
            headers['content-type'] = 'application/json';
            payload = JSON.stringify(options.body);
        }
        const response = await fetch(new URL(url, this.url), { method, headers, body: payload });
        const text = await response.text();
        try {
            return { status: response.status, body: JSON.parse(text) };
        } catch {
            return { status: response.status, body: text };
        }
    }

    /**
     * `cf d1 raw` on the backend's database, which the running backend has open too: SQLite answers `SQLITE_BUSY` when both write at once (the app
     * reading the account every second, say), so a busy database is tried again. So is a 500 from Cloudflare's API, which `cf` asks even for a
     * local database (`Failed to get session commit token`, seen on CI's Windows runners), a little longer each time.
     */
    async #d1(sql: string): Promise<Ran> {
        let ran: Ran;
        for (let attempt = 0; ; attempt++) {
            ran = await exec(CF[0], [CF[1], 'd1', 'raw', DEV_DB_ID, '--local', '--persist-to', this.state, '--sql', sql], {
                env: cfEnv(),
                cwd: API,
                timeout: 60,
            });
            if (ran.code === 0 || attempt >= 8) return ran;
            if (/SQLITE_BUSY|database is locked/i.test(ran.output)) await sleep(0.5);
            else if (/session commit token|500 Internal Server Error/i.test(ran.output)) await sleep(2 * (attempt + 1));
            else return ran;
        }
    }

    /** Rows of a query on the backend's database (`cf d1 raw`): for checking what was stored, which the API does not show. */
    async rows(sql: string): Promise<Record<string, unknown>[]> {
        const ran = await this.#d1(sql);
        if (ran.code !== 0) fail(`querying the backend's database failed: ${sql}`, ran.output);
        const [first] = JSON.parse(ran.output.slice(ran.output.indexOf('['))) as { results: { columns: string[]; rows: unknown[][] } }[];
        const { columns = [], rows = [] } = first?.results ?? {};
        return rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
    }

    /** The keys of the objects in the backend's R2 (local, a SQLite file under the case's folder): what was stored, which the API does not list. */
    objects(): string[] {
        const folder = join(this.state, 'v3', 'r2', 'miniflare-R2BucketObject');
        const files = existsSync(folder)
            ? readdirSync(folder).filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
            : [];
        return files.flatMap((name) => {
            const database = new DatabaseSync(join(folder, name), { readOnly: true });
            try {
                return (database.prepare('SELECT key FROM _mf_objects').all() as { key: string }[]).map((row) => row.key);
            } finally {
                database.close();
            }
        });
    }

    /** Signs `email` in and returns their view of the account, to check from outside what the app put there. */
    async accountOf(email: string): Promise<Account> {
        return new Account(this, (await this.tokensFor(email)).access_token);
    }

    // MARK: The admin API, as the admin SPA's browser calls it

    /** Signs `email` in to the admin (the session cookie a browser would get) and returns a client for `/admin/v1`; fails the case if the sign-in does not end there. */
    async adminAs(email: string, options: { provider?: 'google' | 'github' } = {}): Promise<AdminClient> {
        this.idp.approveAs(email);
        const result = await signInToAdmin(this.url, this.adminUrl, options.provider);
        if (result.kind !== 'session') return fail(`signing in to the admin as ${email} did not end in a session`, JSON.stringify(result));
        return new AdminClient(this.url, this.adminUrl, result.cookie);
    }

    /** The owner (an `adminEmails` address) changes `email`'s monthly limit in the admin, or puts them back on the default (`null`). */
    async setLimit(owner: string, email: string, usd: number | null): Promise<void> {
        const row = (await this.rows(`SELECT id FROM user WHERE email = '${email.replaceAll("'", "''")}'`))[0];
        if (!row) return fail(`${email} is not a user`);
        const admin = await this.adminAs(owner);
        const result = await admin.call('PATCH', `/users/${String(row['id'])}/limit`, { monthlyUsd: usd });
        if (result.status !== 200) fail('changing the limit failed', JSON.stringify(result));
    }

    /** Spend the admin should show: priced calls of `email`, as PR 7 will record them (`usage` table); `at` is the time of each, default now. */
    async seedUsage(
        email: string,
        rows: { feature: string; provider?: string; model?: string; usd: number; at?: Date; units?: number; unit?: string }[],
    ): Promise<void> {
        const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;
        const values = rows.map(
            (row) =>
                `((SELECT id FROM user WHERE email = ${quote(email)}), ${quote(row.feature)}, ${quote(row.provider ?? 'anthropic')}, ${quote(row.model ?? 'test-model')}, ${row.units ?? 1000}, ${quote(row.unit ?? 'input_tokens')}, ${Math.round(row.usd * 1e6)}, ${Math.floor((row.at ?? new Date()).getTime() / 1000)})`,
        );
        const ran = await this.#d1(
            `INSERT INTO usage (user_id, feature, provider, model, units, unit, cost_micros, created_at) VALUES ${values.join(', ')}`,
        );
        if (ran.code !== 0) fail('seeding usage failed', ran.output);
    }
}

/** `/admin/v1` with a session cookie, as the admin SPA's `fetch` sends it (a write also carries the `Origin` of the page, the admin's host). */
export class AdminClient {
    readonly #base: string;
    readonly #admin: string;
    readonly #cookie: string;

    constructor(base: string, admin: string, cookie: string) {
        this.#base = base;
        this.#admin = admin;
        this.#cookie = cookie;
    }

    /** `origin` is the page the request comes from (the admin's own, unless a case plays another site). */
    async call(method: string, path: string, body?: unknown, origin = this.#admin): Promise<{ status: number; body: unknown }> {
        const response = await fetch(new URL(`/admin/v1${path}`, this.#base), {
            method,
            headers: {
                cookie: this.#cookie,
                ...(method === 'GET' ? {} : { origin }),
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        try {
            return { status: response.status, body: JSON.parse(text) as unknown };
        } catch {
            return { status: response.status, body: text };
        }
    }

    get(path: string) {
        return this.call('GET', path);
    }
}

export interface AccountProject {
    id: string;
    name: string;
    occasion: string;
    /** The language Cue last heard in the project's calls. */
    language: string;
    namesAndTerms: string;
    terms: string[];
    /** What Cue wrote from the materials. */
    brief: {
        state: 'none' | 'working' | 'ready' | 'failed';
        error: string | null;
        occasion: string;
        namesAndTerms: string;
        answerCount: number;
        updatedAt: number | null;
    };
    createdAt: number;
    lastUsedAt: number | null;
    materialCount: number;
}

export interface AccountMaterial {
    id: string;
    name: string;
    error: string | null;
    summary: string;
    preparedCount: number;
}

/** What a signed-in person has in the account, read through the Cue API (projects, materials, prepared answers). */
export class Account {
    readonly #backend: Backend;
    readonly token: string;

    constructor(backend: Backend, token: string) {
        this.#backend = backend;
        this.token = token;
    }

    async projects(): Promise<AccountProject[]> {
        return (await this.#backend.call('GET', '/v1/projects', this.token)).body.projects as AccountProject[];
    }

    /** The project with that name; fails the case when there is none. */
    async project(name: string): Promise<AccountProject> {
        const found = (await this.projects()).find((project) => project.name === name);
        return found ?? fail(`the account has no project "${name}"`, JSON.stringify(await this.projects()));
    }

    async materials(project: AccountProject): Promise<AccountMaterial[]> {
        return (await this.#backend.call('GET', `/v1/projects/${project.id}/materials`, this.token)).body.materials as AccountMaterial[];
    }

    /** The text the server extracted from the material with that name. */
    async text(project: AccountProject, name: string): Promise<string> {
        const material = (await this.materials(project)).find((item) => item.name === name);
        if (!material) return fail(`"${project.name}" has no material "${name}"`);
        return (await this.#backend.call('GET', `/v1/projects/${project.id}/materials/${material.id}`, this.token)).body.text as string;
    }

    /** The account's notes (newest first), the project's only when given; trashed ones are not listed. */
    async notes(project?: AccountProject): Promise<Note[]> {
        const query = project ? `?project=${project.id}` : '';
        return (await this.#backend.call('GET', `/v1/notes${query}`, this.token)).body.notes as Note[];
    }

    /** One note; fails the case when the account has none by that id. */
    async note(id: string): Promise<Note> {
        const read = await this.#backend.call('GET', `/v1/notes/${id}`, this.token);
        return read.status === 200 ? (read.body as Note) : fail(`the account has no note ${id}`, JSON.stringify(read));
    }

    /** The prepared answers: the ones written in the materials first (`from` materials), then the ones Cue wrote from them (`cue`). */
    async answers(
        project: AccountProject,
    ): Promise<{ question: string; answer: string; who: string | null; source: string; materialId: string; from: 'materials' | 'cue' }[]> {
        return (await this.#backend.call('GET', `/v1/projects/${project.id}/prepared-answers`, this.token)).body.answers;
    }

    /** Waits until Cue has written the project's brief from its materials (or failed to), and returns the project then. */
    async briefed(name: string, seconds = 60): Promise<AccountProject> {
        const deadline = Date.now() + seconds * 1000;
        for (;;) {
            const project = await this.project(name);
            if (project.brief.state === 'ready' || project.brief.state === 'failed') return project;
            if (Date.now() > deadline) return fail(`the brief of "${name}" was not written in ${seconds} s`, JSON.stringify(project));
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
}
