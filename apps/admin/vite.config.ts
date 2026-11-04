import { cloudflare } from '@cloudflare/vite-plugin';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';

// The API the SPA talks to, stamped into the build: `CUE_API_URL` (a case's backend), else the deployed one (apps/api/production-url.txt) in a build
// and the api's own `cf dev` (its default port) in development.
const productionApi = readFileSync(join(import.meta.dirname, '..', 'api', 'production-url.txt'), 'utf8').trim();
const src = join(import.meta.dirname, 'src');

// `server.port` is the only way to choose `cf dev`'s port (`cf dev --port` is rejected); the e2e harness gives every case's admin its own, as it
// does its backend.
export default defineConfig(({ command }) => ({
    server: { host: '127.0.0.1', port: Number(process.env.PORT ?? 5174), strictPort: true },
    define: {
        'import.meta.env.CUE_API_URL': JSON.stringify(
            process.env.CUE_API_URL ?? (command === 'build' ? productionApi : 'http://127.0.0.1:5173'),
        ),
    },
    plugins: [
        // File-based routes: src/routes/*.tsx become src/routeTree.gen.ts (kept in the repository, as TanStack's own docs do).
        tanstackRouter({ target: 'react', routesDirectory: join(src, 'routes'), generatedRouteTree: join(src, 'routeTree.gen.ts') }),
        // The React Compiler memoizes components itself: no hand-written useMemo / useCallback / memo here.
        react({ babel: { plugins: ['babel-plugin-react-compiler'] } }),
        cloudflare(),
    ],
}));
