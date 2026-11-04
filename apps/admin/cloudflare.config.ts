import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'cf/config';

// The admin's address, kept in one place (production-url.txt): this Worker's host, and the one other origin the API Worker lets call /admin/v1
// with its session cookie (`ADMIN_URL` in apps/api/cloudflare.config.ts).
const productionUrl = readFileSync(join(import.meta.dirname, 'production-url.txt'), 'utf8').trim();

// The owner's admin SPA, a Worker of its own with no code: Vite's client build as static assets, with the single-page-app fallback. Everything it
// shows comes from the API Worker (cue-api), across origins: the two hosts are one site, so the API's SameSite=Lax session cookie goes along.
export default defineConfig(({ mode }) => ({
    worker: {
        name: 'cue-admin',
        compatibilityDate: '2026-10-23',
        // Served on its own host (a custom domain: Cloudflare makes its DNS record and certificate on deploy), and only there. No previews.
        domains: mode === 'development' ? [] : [new URL(productionUrl).hostname],
        workersDev: false,
        previewUrls: false,
        assets: { notFoundHandling: 'single-page-application', htmlHandling: 'auto-trailing-slash' },
    },
}));
