// A sandboxed Cue for one case: its own CUE_HOME, defaults domain and whisper-server port, so
// checkouts can run cases at the same time, and ways to drive the app and wait on it.
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Backend, type BackendOptions } from './backend.ts';
import { closeBrowser } from './browser.ts';
import { ANTHROPIC, CLAUDE, CUE_BIN, DEEPGRAM, E2E_CACHE, E2E_WORK, FAKE_CLAUDE, KEEP, REAL_SUPPORT } from './config.ts';
import {
    FAKE_KEYS,
    startFakeProviders,
    type AnthropicRequest,
    type DeepgramRequest,
    type FakeProviders,
    type MarkdownRequest,
} from './fake-providers.ts';
import {
    countLines,
    exists,
    findFiles,
    isDirectory,
    lines,
    linesOf,
    matches,
    nonEmpty,
    tail,
    withFlags,
    writeExecutable,
} from './files.ts';
import { exec, shellQuote, type Ran } from './process.ts';
import { keychainKey, needOverlaySnapshots, needWhisperCli, needWindowSnapshots } from './requirements.ts';
import { fail, print, Skip } from './results.ts';
import { ocr, readImage } from './screen.ts';
import { sleep, within } from './time.ts';

/** The speaker models' files (FluidAudio's speaker-diarization/ folder) that tell they're all there. */
export const SPEAKER_FILES = [
    'Segmentation.mlmodelc/coremldata.bin',
    'FBank.mlmodelc/coremldata.bin',
    'Embedding.mlmodelc/coremldata.bin',
    'PldaRho.mlmodelc/coremldata.bin',
    'plda-parameters.json',
];

/** A call in the calendar Cue reads (CUE_CALENDAR_EVENTS); times from `minutesFromNow` or `tomorrowAt`. */
export interface CalendarEvent {
    title: string;
    start: string;
    end: string;
    id?: string;
    /** Shared by a recurring event's occurrences. */
    series?: string;
    calendar?: string;
    url?: string;
    location?: string;
    notes?: string;
    attendees?: string[];
    recurring?: boolean;
}

/** What Cue sent the fake claude or the Anthropic API's stand-in, by kind (see tools/fake-claude.ts). */
export type ClaudeRequest = 'answer-system' | 'ask' | 'judge-system' | 'judge' | 'summary-system' | 'summary-input';

/** What the cloud services' stand-ins noted, by kind (see harness/fake-providers.ts). */
export interface ServiceRequests {
    'anthropic-request': AnthropicRequest;
    'deepgram-live': DeepgramRequest;
    'deepgram-file': DeepgramRequest;
    'markdown-request': MarkdownRequest;
}

type DefaultsValue = string | boolean | number | readonly string[];

/** Anything Cue is told before it starts, as environment variables. */
export type LaunchEnv = Record<string, string>;

function speakerModelsIn(models: string): boolean {
    return SPEAKER_FILES.every((file) => exists(join(models, 'speaker-diarization', file)));
}

/** A JSON object in a file, or {} when there is none yet. */
function existsJson(file: string): Record<string, string> {
    try {
        return JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>;
    } catch {
        return {};
    }
}

/** A whisper-server port nothing listens on yet. */
async function freePort(): Promise<number> {
    for (let attempt = 0; attempt < 50; attempt++) {
        const port = 20000 + Math.floor(Math.random() * 20000);
        const listening = await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
        if (listening.code !== 0) return port;
    }
    throw new Error('no free port for whisper-server');
}

export class Cue {
    /** The case's sandbox folder; everything the case makes goes here. */
    readonly dir: string;
    /** CUE_HOME: holds `Application Support/Cue` and `Documents`. */
    readonly home: string;
    /** `Application Support/Cue`: sessions, recordings, models. */
    readonly support: string;
    readonly documents: string;
    /** The calendar Cue reads (see `calendar`). */
    readonly events: string;
    /** The apps using the microphone (see `micApps`). */
    readonly micAppsFile: string;
    /** Where the fake claude records what Cue sent it. */
    readonly claudeLog: string;
    readonly domain: string;
    readonly port: number;
    /** The environment of every Cue this case runs. */
    readonly env: NodeJS.ProcessEnv;
    /** Where Cue keeps API keys under CUE_HOME, instead of the keychain. */
    readonly keysFile: string;
    #app: ChildProcess | undefined;
    /** The environment of the Cue running, for the services' stand-ins to reply by. */
    #launched: NodeJS.ProcessEnv = {};
    #providers: FakeProviders | undefined;
    #backend: Promise<Backend> | undefined;
    #closing: Promise<void> | undefined;
    /** The name of the case, for the email of its user. */
    readonly #name: string;

    private constructor(dir: string, domain: string, port: number) {
        this.dir = dir;
        this.#name = basename(dir).replace(/\.[^.]*$/, '');
        this.home = join(dir, 'home');
        this.support = join(this.home, 'Application Support', 'Cue');
        this.documents = join(this.home, 'Documents');
        this.events = join(dir, 'events.json');
        this.micAppsFile = join(dir, 'mic-apps');
        this.claudeLog = join(dir, 'claude');
        this.keysFile = join(this.home, 'Keychain.json');
        this.domain = domain;
        this.port = port;
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            // The fake claude is a Node script (`#!/usr/bin/env node`): the Node running the cases runs it too.
            PATH: [dirname(process.execPath), process.env['PATH']].filter(Boolean).join(':'),
            CUE_HOME: this.home,
            CUE_DEFAULTS_DOMAIN: domain,
            CUE_WHISPER_PORT: String(port),
        };
        delete env['NODE_TEST_CONTEXT'];
        // The speaker models come in with the speech model once they are downloaded; until then Cue
        // downloads them on first use into the checkout's e2e cache, and later cases and runs reuse them.
        if (!speakerModelsIn(join(REAL_SUPPORT, 'models'))) env['CUE_SPEAKER_MODELS'] = join(E2E_CACHE, 'speaker-models');
        if (CLAUDE === 'fake') {
            env['CUE_CLAUDE_BIN'] = FAKE_CLAUDE;
            env['FAKE_CLAUDE_LOG'] = this.claudeLog;
        }
        this.env = env;
    }

    /** Makes the sandbox for case `name`. */
    static async open(name: string): Promise<Cue> {
        const dir = await mkdtemp(join(E2E_WORK, `${name}.`));
        const cue = new Cue(dir, `com.andriishafar.cue.e2e.${name}-${process.pid}`, await freePort());
        await mkdir(cue.support, { recursive: true });
        await mkdir(cue.documents, { recursive: true });
        // The speech model is 1.6 GB: link it in, never copy or download it.
        const models = join(REAL_SUPPORT, 'models');
        if (isDirectory(models)) await symlink(models, join(cue.support, 'models'));
        await exec('defaults', ['delete', cue.domain]);
        if (CLAUDE === 'fake') await mkdir(cue.claudeLog, { recursive: true });
        // The cloud services' stand-ins, unless the run uses the real ones.
        if (ANTHROPIC === 'fake' || DEEPGRAM === 'fake') {
            cue.#providers = await startFakeProviders(cue.claudeLog, () => cue.#launched);
            if (ANTHROPIC === 'fake') cue.env['CUE_ANTHROPIC_URL'] = cue.#providers.url;
            if (DEEPGRAM === 'fake') cue.env['CUE_DEEPGRAM_URL'] = cue.#providers.url;
        }
        return cue;
    }

    /**
     * Quits Cue and whatever it left running, forgets its settings, and removes the sandbox unless
     * the case failed (or `--keep`). Safe to call more than once.
     */
    close(succeeded: boolean): Promise<void> {
        this.#closing ??= (async () => {
            await this.stop();
            await closeBrowser(succeeded);
            await (await this.#backend?.catch(() => undefined))?.stop();
            await this.#providers?.close();
            // A real key never stays behind, not even in a kept sandbox.
            await rm(this.keysFile, { force: true });
            // Left behind if Cue was killed.
            await exec('pkill', ['-f', '--', `whisper-server .*--port ${this.port}( |$)`]);
            await exec('defaults', ['delete', this.domain]);
            await rm(join(homedir(), 'Library', 'Preferences', `${this.domain}.plist`), { force: true });
            if (succeeded && !KEEP) await rm(this.dir, { recursive: true, force: true });
            else print(`Sandbox kept: ${this.dir}`);
        })();
        return this.#closing;
    }

    // MARK: Files

    /** A path in the sandbox folder. */
    path(...parts: string[]): string {
        return join(this.dir, ...parts);
    }

    /** Writes `text` to a file in the sandbox folder and returns its path. */
    save(name: string, text: string): string {
        const file = this.path(name);
        writeFileSync(file, text);
        return file;
    }

    /** A project's folder, Documents/Cue/NAME. */
    projectPath(name: string): string {
        return join(this.documents, 'Cue', name);
    }

    /** Makes a project by hand, as a folder with its project.json; returns the folder. */
    async project(name: string, settings: Record<string, string> = {}): Promise<string> {
        const folder = this.projectPath(name);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, 'project.json'), `${JSON.stringify({ name, ...settings }, null, 2)}\n`);
        return folder;
    }

    // MARK: Driving Cue

    /**
     * Saves a provider's API key where Cue keeps it under CUE_HOME, as Settings › Providers would: the
     * stand-in's (FAKE_KEYS), `key` (one the stand-in rejects, say), or with `--real-anthropic` /
     * `--real-deepgram` the real one from the login keychain.
     */
    async apiKey(service: 'anthropic' | 'deepgram', key?: string): Promise<void> {
        const real = (service === 'anthropic' ? ANTHROPIC : DEEPGRAM) === 'real';
        const keys = existsJson(this.keysFile);
        keys[service] = key ?? (real ? await keychainKey(service) : FAKE_KEYS[service]);
        await writeFile(this.keysFile, JSON.stringify(keys));
    }

    /**
     * Writes a setting into the case's defaults domain, typed by its value:
     * `defaults('language', 'uk')`, `defaults('materials', [a, b])`, `defaults('autoAnswer', true)`.
     */
    async defaults(key: string, value: DefaultsValue): Promise<void> {
        const typed =
            typeof value === 'string'
                ? ['-string', value]
                : typeof value === 'boolean'
                  ? ['-bool', String(value)]
                  : typeof value === 'number'
                    ? [Number.isInteger(value) ? '-int' : '-float', String(value)]
                    : ['-array', ...value];
        const wrote = await exec('defaults', ['write', this.domain, key, ...typed]);
        if (wrote.code !== 0) fail(`defaults write ${key} failed`, wrote.output);
    }

    /**
     * The case's own backend (apps/api under `cf dev`, with its own database and stand-in sign-in; harness/backend.ts), started on the
     * first call and stopped with the case. `options` apply to that first call. `launch` starts it for you, and invites `email`.
     */
    backend(options: BackendOptions = {}): Promise<Backend> {
        this.#backend ??= Backend.start(this.dir, {
            ...options,
            // What the backend calls upstream is what this case's stand-ins answer.
            env: {
                ...(this.#providers
                    ? {
                          ANTHROPIC_URL: this.#providers.url,
                          DEEPGRAM_URL: this.#providers.url,
                          MARKDOWN_URL: `${this.#providers.url}/markdown`,
                      }
                    : {}),
                ...options.env,
            },
        });
        return this.#backend;
    }

    /** The email of the case's user: invited at the first signed-in `launch`, and the one the stand-in sign-in approves. */
    get email(): string {
        return `${this.#name}-${process.pid}@cue.test`.toLowerCase().replace(/[^a-z0-9@.-]/g, '-');
    }

    /** The refresh token Cue keeps under CUE_HOME while signed in (it signed in, and has not signed out); undefined otherwise. */
    get refreshToken(): string | undefined {
        return existsJson(this.keysFile)['cueRefreshToken'];
    }

    /** Whether Cue has a refresh token saved, as it has between signing in and signing out. */
    get signedIn(): boolean {
        return Boolean(this.refreshToken);
    }

    /**
     * Starts the app in the background with live audio off (pass CUE_NO_LIVE_AUDIO: '0' to override),
     * out of the user's way (CUE_BACKGROUND: never in front, never taking focus), the calendar read
     * from `events` and the microphone users from `micAppsFile`, and waits for its session log. Its
     * output goes to cue.out.
     *
     * Cue is for invited people who have signed in, so by default this also starts the case's backend, invites `email` and signs in
     * (headless, `CUE_WEB_AUTH`), waiting for `🔑 Signed in to Cue as …`; a relaunch finds its refresh token and signs in on its own.
     * `signIn: false` launches signed out (still pointed at the backend, in headless mode), for a case that drives the sign-in itself.
     */
    async launch(env: LaunchEnv = {}, options: { signIn?: boolean; backend?: BackendOptions } = {}): Promise<void> {
        const backend = await this.backend(options.backend);
        if (options.signIn !== false) {
            await backend.invite(this.email);
            backend.idp.approveAs(this.email);
        }
        const previous = this.#newestSessionLog();
        writeFileSync(this.path('control'), '');
        const out = openSync(this.path('cue.out'), 'a');
        this.#launched = {
            ...this.env,
            CUE_NO_LIVE_AUDIO: '1',
            CUE_BACKGROUND: '1',
            CUE_CONTROL: this.path('control'),
            CUE_CALENDAR_EVENTS: this.events,
            CUE_MIC_APPS: this.micAppsFile,
            CUE_API_URL: backend.url,
            CUE_WEB_AUTH: 'headless',
            ...env,
        };
        const app = spawn(CUE_BIN, [], { env: this.#launched, stdio: ['ignore', out, out] });
        closeSync(out);
        app.on('error', (error) => appendFileSync(this.path('cue.out'), `couldn't start Cue: ${error.message}\n`));
        this.#app = app;
        // A relaunch in the same case starts a new log (they are named by the second).
        await this.waitFor('Cue to start', 30, () => {
            const log = this.#newestSessionLog();
            return log !== undefined && log !== previous;
        });
        if (options.signIn !== false) await this.signIn();
    }

    /** Signs in, as a click on Sign in would, and waits for it (unless Cue signed in on its own from the refresh token it kept). */
    async signIn(): Promise<void> {
        if (!this.signedIn) this.control('signin');
        await this.waitLog(/🔑 Signed in to Cue as /, 60);
    }

    /** Quits the app the way Ctrl-C does (a clean shutdown), then makes sure. */
    async stop(): Promise<void> {
        const app = this.#app;
        if (!app) return;
        const exited = new Promise<void>((resolve) => {
            if (app.exitCode !== null || app.signalCode !== null || app.pid === undefined) resolve();
            else app.once('exit', () => resolve());
        });
        app.kill('SIGTERM');
        if (!(await within(exited, 10))) {
            app.kill('SIGKILL');
            await exited;
        }
        this.#app = undefined;
    }

    /** The launched app's process ID. */
    get pid(): number {
        return this.#app?.pid ?? fail('Cue is not running');
    }

    /** Whether the launched app is still running. */
    alive(): boolean {
        const app = this.#app;
        return app !== undefined && app.pid !== undefined && app.exitCode === null && app.signalCode === null;
    }

    /** The app's command-line modes (--inspect, --render, …), in this sandbox. */
    cli(...args: string[]): Promise<Ran> {
        return exec(CUE_BIN, args, { env: { ...this.env, CUE_NO_LIVE_AUDIO: '1' } });
    }

    /**
     * Does in the running Cue what a click would (CUE_CONTROL): `new NAME`, `add PATH`, `start NAME`,
     * `project NAME`, `ask TEXT`, `timestamp HH:MM:SS`, `page home|upcoming|NAME|NAME/answers|NAME/notes`,
     * `assign EVENT | PROJECT`, `notification record|dismiss`, and for the open note `rename NAME | NEW`,
     * `apply LABEL` and `dismiss LABEL`, and `download speakers`.
     */
    control(command: string): void {
        appendFileSync(this.path('control'), `${command}\n`);
    }

    /** The calendar Cue reads on every check from now on. */
    calendar(events: CalendarEvent[]): void {
        this.#replace(this.events, `${JSON.stringify(events, null, 2)}\n`);
    }

    /** The processes using the microphone right now (bundle IDs); none when the call app let go. */
    micApps(...bundleIds: string[]): void {
        this.#replace(this.micAppsFile, `${bundleIds.join('\n')}\n`);
    }

    /** Swaps a file Cue keeps reading in one step, so it never reads it half-written. */
    #replace(file: string, text: string): void {
        writeFileSync(`${file}.new`, text);
        renameSync(`${file}.new`, file);
    }

    /**
     * Writes a `whisper-cli` for CUE_WHISPER_CLI that notes how Cue runs it (the arguments, one per line,
     * in whisper-args.txt; its scheduling priority in whisper-priority.txt), takes `seconds` longer, as a
     * long call would, and runs the real whisper-cli. Returns its path. It's a shell script so that it can
     * `exec` the real one: the same process, with the priority and signals Cue gives it.
     */
    async whisperCliSpy(seconds = 0.5): Promise<string> {
        const whisperCli = needWhisperCli();
        return writeExecutable(
            this.path('whisper-cli'),
            [
                '#!/bin/bash',
                `printf '%s\\n' "$@" > ${shellQuote(this.path('whisper-args.txt'))}`,
                `sleep ${seconds}`,
                `ps -o pri= -p $$ | tr -d ' ' > ${shellQuote(this.path('whisper-priority.txt'))}`,
                `exec ${shellQuote(whisperCli)} "$@"`,
                '',
            ].join('\n'),
        );
    }

    // MARK: Waiting

    /**
     * Polls `check` every half second until it holds; fails the case on timeout, or as soon as a
     * launched Cue exits. A check that throws hasn't held yet, unless it skips the case.
     */
    async waitFor(what: string, seconds: number, check: () => boolean | Promise<boolean>): Promise<void> {
        const deadline = Date.now() + seconds * 1000;
        for (;;) {
            const held = await Promise.resolve()
                .then(check)
                .catch((error: unknown) => {
                    if (error instanceof Skip) throw error;
                    return false;
                });
            if (held) return;
            if (this.#app && !this.alive()) {
                fail(`Cue exited while waiting for ${what}`, '--- cue.out', tail(this.path('cue.out'), 40));
            }
            if (Date.now() >= deadline) {
                const log = this.#newestSessionLog();
                fail(`timed out after ${seconds}s waiting for ${what}`, ...(log ? ['--- session log', tail(log, 40)] : []));
            }
            await sleep(0.5);
        }
    }

    /** Waits for a line in the session log that matches (as written: case matters). */
    waitLog(pattern: RegExp, seconds: number): Promise<void> {
        const regex = withFlags(pattern);
        return this.waitFor(`log line /${pattern.source}/`, seconds, () => {
            const log = this.#newestSessionLog();
            return log !== undefined && lines(log).some((line) => regex.test(line));
        });
    }

    #newestSessionLog(): string | undefined {
        const sessions = join(this.support, 'sessions');
        let newest: { path: string; time: number } | undefined;
        try {
            for (const name of readdirSync(sessions)) {
                if (!name.endsWith('.md')) continue;
                const path = join(sessions, name),
                    time = statSync(path).mtimeMs;
                if (!newest || time > newest.time) newest = { path, time };
            }
        } catch {
            return undefined;
        }
        return newest?.path;
    }

    /** The newest session log (Application Support/Cue/sessions/*.md), the app's record of what it did. */
    sessionLog(): string {
        return this.#newestSessionLog() ?? fail('Cue has written no session log');
    }

    /** How many session log lines match (as written: case matters). */
    logCount(pattern: RegExp): number {
        return countLines(this.sessionLog(), pattern);
    }

    /** The notes file named by the last "Notes ready:" log line ('' when there is none). */
    readyNotes(): string {
        return (
            matches(this.sessionLog(), /Notes ready: .*/)
                .at(-1)
                ?.slice('Notes ready: '.length) ?? ''
        );
    }

    /** Every Markdown note under the sandbox's Documents (materials excluded). */
    findNotes(): string[] {
        return findFiles(this.documents, /\.md$/, /\/Materials\//);
    }

    /** What Cue sent the fake claude or the Anthropic API's stand-in: every request of that kind, oldest first. */
    claudeRequests(kind: ClaudeRequest): string[] {
        if (CLAUDE !== 'fake' && ANTHROPIC !== 'fake') fail('claudeRequests needs the fake claude or the Anthropic stand-in');
        return this.#noted(kind);
    }

    /** What the cloud services' stand-ins noted about Cue's requests of that kind, oldest first. */
    serviceRequests<Kind extends keyof ServiceRequests>(kind: Kind): ServiceRequests[Kind][] {
        if ((kind === 'anthropic-request' ? ANTHROPIC : kind === 'markdown-request' ? 'fake' : DEEPGRAM) !== 'fake')
            fail(`serviceRequests('${kind}') needs the stand-in`);
        return this.#noted(kind).map((text) => JSON.parse(text) as ServiceRequests[Kind]);
    }

    #noted(kind: string): string[] {
        let names: string[];
        try {
            names = readdirSync(this.claudeLog)
                .filter((name) => name.endsWith(`-${kind}.txt`))
                .sort();
        } catch {
            names = [];
        }
        return names.map((name) => readFileSync(join(this.claudeLog, name), 'utf8'));
    }

    // MARK: Screens

    /** The text of the dashboard page last read by `dashboardShows` / `dashboardPage`. */
    get page(): string {
        return this.path('page.txt');
    }

    /**
     * With CUE_SNAPSHOT=cue.path('cue.png'): whether the dashboard's snapshot now reads `pattern`
     * (ignoring case), counting only a snapshot drawn after `since` (a Date.now() time). Its text is
     * then in `page`.
     */
    async dashboardShows(pattern: RegExp, since = 0): Promise<boolean> {
        needWindowSnapshots();
        const png = this.path('cue-dashboard.png');
        if (!nonEmpty(png) || statSync(png).mtimeMs <= since) return false;
        const read = await readImage(png);
        writeFileSync(this.page, read.stdout);
        const regex = withFlags(pattern, 'i');
        return read.code === 0 && linesOf(read.stdout).some((line) => regex.test(line));
    }

    /**
     * Shows a dashboard page (`home`, `upcoming`, `NAME/notes`, …) and waits until a snapshot drawn
     * since then reads `pattern` (one drawn before can show the page as it was a moment ago).
     */
    async dashboardPage(page: string, pattern: RegExp): Promise<void> {
        needWindowSnapshots();
        const asked = Date.now();
        this.control(`page ${page}`);
        await this.waitFor(`the ${page} page to show /${pattern.source}/`, 20, () => this.dashboardShows(pattern, asked));
    }

    /**
     * Waits for CUE_SNAPSHOT to write `png`, lets the window settle a frame, and reads its text:
     * `…-dashboard.png` and `…-settings.png` are windows, the CUE_SNAPSHOT file itself the overlay.
     */
    async snapshotText(png: string): Promise<string> {
        if (/-(dashboard|settings)\.png$/.test(png)) needWindowSnapshots();
        else needOverlaySnapshots();
        await this.waitFor(`snapshot ${png}`, 20, () => nonEmpty(png));
        await sleep(2.5);
        return ocr(png);
    }
}
