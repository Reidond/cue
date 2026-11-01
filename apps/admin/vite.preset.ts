import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { join } from 'node:path';
import type { UserConfig } from 'vite';

// The admin SPA is built as the *client environment* of the api's Vite project: `cf` ships whatever Vite's client build produces as the
// Worker's static assets, so this is how the SPA gets onto the same Worker (the backend spike's FINDINGS § 5). The api project holds a
// one-line `index.html` that points at the SPA's entry: Vite can't emit an HTML input from outside its root, and moving the root breaks
// `cf` (it looks for `.cloudflare/output` and cloudflare.config.ts there).
export function adminClient(): UserConfig {
    const src = join(import.meta.dirname, 'src');
    return {
        base: '/admin/',
        plugins: [
            // File-based routes: src/routes/*.tsx become src/routeTree.gen.ts (kept in the repository, as TanStack's own docs do).
            tanstackRouter({ target: 'react', routesDirectory: join(src, 'routes'), generatedRouteTree: join(src, 'routeTree.gen.ts') }),
            // The React Compiler memoizes components itself: no hand-written useMemo / useCallback / memo here.
            react({ babel: { plugins: ['babel-plugin-react-compiler'] } }),
        ],
    };
}
