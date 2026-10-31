// Fails when `cf` would build with upstream Vite instead of Vite+'s (docs/backend.md; the backend spike's FINDINGS § 1). The three
// settings that prevent it are the `vite@*` override and `autoInstallPeers: false` in pnpm-workspace.yaml, and no `vite` dependency in
// apps/api; without any of them the build still works, silently on the wrong Vite.
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const problems: string[] = [];

if (existsSync(join(root, 'node_modules', '.bin', 'vite'))) {
    problems.push('apps/api/node_modules/.bin/vite exists: `cf` would run `npx vite`. Remove `vite` from apps/api/package.json.');
}
// The `vite` the plugin resolves is the one next to it in pnpm's virtual store.
const plugin = realpathSync(join(root, 'node_modules', '@cloudflare', 'vite-plugin'));
const vite = realpathSync(join(plugin, '..', '..', 'vite'));
if (!vite.includes('vite-plus-core')) {
    problems.push(
        `@cloudflare/vite-plugin resolves vite to ${vite}, not Vite+'s core. Check the override and autoInstallPeers in pnpm-workspace.yaml.`,
    );
}

if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log(`ok: the plugin builds with ${vite.split('node_modules/').pop()}`);
