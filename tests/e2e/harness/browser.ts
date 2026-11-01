// The suite's browser: Playwright (playwright-core, which downloads nothing) driving the machine's Chrome, headless, for the cases that use the
// admin SPA the way its owner does. `E2E_BROWSER=path` names another Chrome or Chromium. A machine without one skips those cases.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright-core';
import type { Backend } from './backend.ts';
import { fail, print, skip } from './results.ts';

let launching: Promise<Browser> | undefined;

/** The browser, started on first use and shared by the case's pages. Skips the case when the machine has no Chrome. */
export async function browser(): Promise<Browser> {
    launching ??= chromium.launch({
        headless: true,
        ...(process.env['E2E_BROWSER'] ? { executablePath: process.env['E2E_BROWSER'] } : { channel: 'chrome' }),
        args: ['--no-sandbox'],
    });
    try {
        return await launching;
    } catch (error) {
        launching = undefined;
        return skip(`no Chrome to drive (${(error instanceof Error ? error.message : String(error)).split('\n')[0]}); set E2E_BROWSER`);
    }
}

const opened = new Set<AdminPage>();

/**
 * Closes the browser the case opened (the sandbox calls this when the case ends). A failed case first leaves a screenshot of every page
 * that was open, and says where each one was and what it showed.
 */
export async function closeBrowser(succeeded = true): Promise<void> {
    if (!succeeded) {
        for (const admin of opened) {
            const shot = await admin.shot('failure').catch(() => undefined);
            const text = await admin.page.innerText('body', { timeout: 2000 }).catch(() => '');
            print(
                `--- the admin at ${admin.page.url()}${shot ? ` (screenshot ${shot})` : ''}`,
                text.slice(0, 1200),
                admin.problems.join('\n'),
            );
        }
    }
    opened.clear();
    const started = launching;
    launching = undefined;
    await (await started?.catch(() => undefined))?.close().catch(() => undefined);
}

export interface AdminOptions {
    /** `prefers-color-scheme` of the page. */
    scheme?: 'light' | 'dark';
    viewport?: { width: number; height: number };
    /** Where `shot` writes screenshots (they never leave the case's sandbox). */
    shots: string;
}

/** The admin SPA in a browser of its own: one signed-in person's tab. */
export class AdminPage {
    readonly page: Page;
    /** Console errors, uncaught exceptions and failed requests of the page since it opened. */
    readonly problems: string[] = [];
    readonly #base: string;
    readonly #shots: string;
    readonly #scheme: string;

    private constructor(page: Page, base: string, shots: string, scheme: string) {
        this.page = page;
        this.#base = base;
        this.#shots = shots;
        this.#scheme = scheme;
        page.on('pageerror', (error) => this.problems.push(`exception: ${error.message}`));
        page.on('console', (message) => {
            // "Failed to load resource" is the browser's note on a 4xx: the 401 of a signed-out page and the 403 of a member are answers.
            if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
                this.problems.push(`console: ${message.text()}`);
        });
        // A refusal the case provokes (401, 403) is an answer; a 5xx is a bug.
        page.on('response', (response) => {
            if (response.status() >= 500) this.problems.push(`${response.status()} ${response.url()}`);
        });
    }

    /** The admin SPA in a fresh browser, signed out. */
    static async open(backend: Backend, options: AdminOptions): Promise<AdminPage> {
        const context = await (
            await browser()
        ).newContext({
            colorScheme: options.scheme ?? 'light',
            viewport: options.viewport ?? { width: 1280, height: 860 },
            deviceScaleFactor: 2,
            reducedMotion: 'reduce',
        });
        await mkdir(options.shots, { recursive: true });
        const admin = new AdminPage(await context.newPage(), backend.url, options.shots, options.scheme ?? 'light');
        opened.add(admin);
        await admin.page.goto(`${backend.url}/admin/`);
        return admin;
    }

    /** Opens the admin as `email`, signing in through the stand-in identity provider as the SPA's own button does. */
    static async signIn(backend: Backend, email: string, options: AdminOptions): Promise<AdminPage> {
        const admin = await AdminPage.open(backend, options);
        backend.idp.approveAs(email);
        await admin.page.getByRole('link', { name: 'Continue with Google' }).click();
        await admin.page.waitForURL(/\/admin\//);
        return admin;
    }

    /** Opens a page of the admin (`/users`, `/invites?…`) and waits for it to load. */
    async go(path: string): Promise<void> {
        await this.page.goto(`${this.#base}/admin${path}`);
    }

    /** Waits until the SPA's navigation shows (the person is an owner). */
    async waitForShell(): Promise<void> {
        try {
            await this.page.getByRole('navigation', { name: 'Admin' }).waitFor({ timeout: 20_000 });
        } catch {
            const shot = await this.shot('failed');
            fail(
                'the admin did not show its navigation',
                `at ${this.page.url()} (screenshot ${shot})`,
                (await this.page.innerText('body')).slice(0, 1500),
                this.problems.join('\n'),
            );
        }
    }

    /** Fails the case if the page logged an error, threw, or got a 5xx. */
    assertClean(): void {
        if (this.problems.length > 0) fail('errors in the page', this.problems.join('\n'));
    }

    /** Clicks a link in the navigation. */
    async navigate(name: string): Promise<void> {
        await this.page.getByRole('navigation', { name: 'Admin' }).getByRole('link', { name }).click();
    }

    /** A full-page screenshot in the case's sandbox: `shots/NAME-light.png`. */
    async shot(name: string): Promise<string> {
        const file = join(this.#shots, `${name}-${this.#scheme}.png`);
        // Motion has settled by the time anyone looks; nothing is taken mid-transition.
        await this.page.waitForTimeout(250);
        await this.page.screenshot({ path: file, fullPage: true });
        return file;
    }

    async close(): Promise<void> {
        opened.delete(this);
        await this.page.context().close();
    }
}
