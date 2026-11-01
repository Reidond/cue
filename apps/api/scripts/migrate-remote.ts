// Applies the migrations (apps/api/migrations) to the deployed D1 database, found by its name ("cue"; CUE_D1_ID names it when that fails). The
// deploy workflow runs it before `cf deploy` and after it: the database does not exist before the very first deploy (`cf deploy` provisions it), so
// `--if-exists` lets the first run say so and succeed, and the second one does the work. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const cf = join(root, 'node_modules', '.bin', 'cf');
const ifExists = process.argv.includes('--if-exists');
const dry = process.argv.includes('--dry-run');

function run(args: string[]) {
    return spawnSync(cf, args, { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1' } });
}

let id = process.env.CUE_D1_ID;
if (!id) {
    const listing = run(['d1', 'list']);
    if (listing.status !== 0) {
        console.error(`cf d1 list failed:\n${listing.stdout}${listing.stderr}`);
        process.exit(1);
    }
    const text = listing.stdout;
    const json = JSON.parse(text.slice(text.search(/[[{]/))) as unknown;
    const rows = (Array.isArray(json) ? json : ((json as { result?: unknown[] }).result ?? [])) as Record<string, string>[];
    id =
        rows.find((row) => (row.name ?? '').toLowerCase() === 'cue')?.uuid ??
        rows.find((row) => (row.name ?? '').toLowerCase() === 'cue')?.id;
}
if (!id) {
    if (ifExists) {
        console.log(
            '::notice::The D1 database "cue" does not exist yet: this is the first deploy, which creates it. Migrations are applied after it.',
        );
        process.exit(0);
    }
    console.error('Could not find the D1 database "cue". Deploy first (`cf deploy` creates it), or set CUE_D1_ID.');
    process.exit(1);
}

const applied = spawnSync(cf, ['d1', 'migrations', 'apply', id, ...(dry ? ['--dry-run'] : [])], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, CI: '1' },
});
process.exit(applied.status ?? 1);
