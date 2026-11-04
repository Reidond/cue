// Fails when `cf` would build either Worker (apps/api, apps/admin) with upstream Vite instead of Vite+'s (docs/backend.md; the backend spike's
// FINDINGS § 1). The three settings that prevent it are the `vite@*` override and `autoInstallPeers: false` in pnpm-workspace.yaml, and no `vite`
// dependency in apps/api or apps/admin; without any of them the build still works, silently on the wrong Vite.
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const apps = join(import.meta.dirname, '..', '..');
const problems: string[] = [];
const found: string[] = [];

for (const app of ['api', 'admin']) {
    const root = join(apps, app);
    if (existsSync(join(root, 'node_modules', '.bin', 'vite'))) {
        problems.push(
            `apps/${app}/node_modules/.bin/vite exists: \`cf\` would run \`npx vite\`. Remove \`vite\` from apps/${app}/package.json.`,
        );
    }
    // The `vite` the plugin resolves is the one next to it in pnpm's virtual store.
    const plugin = realpathSync(join(root, 'node_modules', '@cloudflare', 'vite-plugin'));
    const vite = realpathSync(join(plugin, '..', '..', 'vite'));
    if (!vite.includes('vite-plus-core')) {
        problems.push(
            `apps/${app}: @cloudflare/vite-plugin resolves vite to ${vite}, not Vite+'s core. Check the override and autoInstallPeers in pnpm-workspace.yaml.`,
        );
    }
    found.push(`${app}: ${vite.split('node_modules/').pop()}`);
}

if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log(`ok: the plugin builds with ${found.join(', ')}`);
