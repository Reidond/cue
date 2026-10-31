// The owner's tool for who may use Cue. Works on the local database (`cf dev`'s, in .cloudflare/state or CUE_STATE_DIR) and, with
// `--remote`, on the deployed one, through the `cf` CLI.
//
//   pnpm --filter api invite EMAIL              invite EMAIL (and enable them again if they were disabled)
//   pnpm --filter api invite EMAIL --disable    disable EMAIL: sign them out everywhere, refuse them from now on
//   pnpm --filter api invite --list             who is invited, and who has signed in
//
// Local databases need their migrations first (`pnpm --filter api migrate`). `--remote` finds the deployed database and the denylist by
// name; if that fails, give their ids in CUE_D1_ID and CUE_KV_ID.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DEV_DB_ID, DEV_KV_ID } from '../dev-ids.ts';

const root = join(import.meta.dirname, '..');
const cf = join(root, 'node_modules', '.bin', 'cf');
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const email = args
    .find((arg) => !arg.startsWith('--'))
    ?.trim()
    .toLowerCase();
const remote = flag('--remote');

function usage(message: string): never {
    console.error(`${message}\nusage: invite EMAIL [--disable] [--remote]   |   invite --list [--remote]`);
    process.exit(2);
}

function run(...cfArgs: string[]): string {
    const ran = spawnSync(cf, cfArgs, { cwd: root, encoding: 'utf8', env: { ...process.env, CI: '1' } });
    if (ran.status !== 0) {
        console.error(`cf ${cfArgs.slice(0, 3).join(' ')} failed:\n${ran.stderr || ran.stdout}`);
        process.exit(1);
    }
    return ran.stdout;
}

/** Where a command runs: the local persisted state, or Cloudflare. */
const place = remote ? [] : ['--local', '--persist-to', process.env.CUE_STATE_DIR ?? '.cloudflare/state'];

function idByName(kind: 'd1' | 'kv', name: string): string {
    const listing = kind === 'd1' ? run('d1', 'list') : run('kv', 'namespaces', 'list');
    const json = JSON.parse(listing.slice(listing.search(/[[{]/))) as unknown;
    const rows = (Array.isArray(json) ? json : ((json as { result?: unknown[] }).result ?? [])) as Record<string, string>[];
    const found = rows.find((row) => (row.name ?? row.title ?? '').toLowerCase().includes(name));
    const id = found?.uuid ?? found?.id;
    if (!id)
        usage(
            `Could not find the ${kind === 'd1' ? 'database' : 'denylist'} "${name}" on Cloudflare. Set ${kind === 'd1' ? 'CUE_D1_ID' : 'CUE_KV_ID'}.`,
        );
    return id;
}

const databaseId = remote ? (process.env.CUE_D1_ID ?? idByName('d1', 'cue')) : DEV_DB_ID;
const denylistId = remote ? (process.env.CUE_KV_ID ?? idByName('kv', 'denylist')) : DEV_KV_ID;

/** Rows of the last statement, as objects. */
function sql(statement: string): Record<string, unknown>[] {
    const out = run('d1', 'raw', databaseId, ...place, '--sql', statement);
    const results = (JSON.parse(out.slice(out.indexOf('['))) as { results: { columns: string[]; rows: unknown[][] } }[]).at(-1)?.results;
    return (results?.rows ?? []).map((row) => Object.fromEntries((results?.columns ?? []).map((column, index) => [column, row[index]])));
}

const quote = (text: string) => `'${text.replaceAll("'", "''")}'`;

if (flag('--list')) {
    const rows = sql(
        `SELECT i.email AS email, i.disabled AS disabled, u.id AS user FROM invite i LEFT JOIN user u ON lower(u.email) = i.email ORDER BY i.created_at`,
    );
    for (const row of rows) console.log(`${String(row.email)}\t${row.disabled ? 'disabled' : row.user ? 'signed in' : 'invited'}`);
    process.exit(0);
}

if (!email || !/^[^\s@'";]+@[^\s@'";]+\.[^\s@'";]+$/.test(email)) usage('Give the email address to invite.');
const known = sql(`SELECT id FROM user WHERE email = ${quote(email)}`)[0]?.id as string | undefined;
const denylisted = `disabled:${known}`;

if (flag('--disable')) {
    // Revoking everything first, then the denylist: a disabled person's access tokens (valid for up to 15 minutes) stop working at once.
    sql(
        `INSERT INTO invite (email, disabled) VALUES (${quote(email)}, 1) ON CONFLICT(email) DO UPDATE SET disabled = 1;
UPDATE user SET banned = 1, banReason = 'disabled by the owner' WHERE email = ${quote(email)};
DELETE FROM oauthRefreshToken WHERE userId IN (SELECT id FROM user WHERE email = ${quote(email)});
DELETE FROM oauthAccessToken WHERE userId IN (SELECT id FROM user WHERE email = ${quote(email)});
DELETE FROM session WHERE userId IN (SELECT id FROM user WHERE email = ${quote(email)})`,
    );
    if (known) run('kv', 'keys', 'put', denylisted, '--namespace-id', denylistId, ...place, '--body', '1');
    console.log(`disabled ${email}${known ? '' : ' (not signed in before)'}`);
} else {
    sql(
        `INSERT INTO invite (email, disabled) VALUES (${quote(email)}, 0) ON CONFLICT(email) DO UPDATE SET disabled = 0;
UPDATE user SET banned = 0, banReason = NULL, banExpires = NULL WHERE email = ${quote(email)}`,
    );
    if (known) run('kv', 'keys', 'delete', denylisted, '--namespace-id', denylistId, ...place, '--force');
    console.log(`invited ${email}`);
}
