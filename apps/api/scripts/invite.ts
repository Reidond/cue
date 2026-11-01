// The owner's tool for who may use Cue. Works on the local database (`cf dev`'s, in .cloudflare/state or CUE_STATE_DIR) and, with
// `--remote`, on the deployed one, through the `cf` CLI.
//
//   pnpm --filter api invite EMAIL              invite EMAIL (and enable them again if they were disabled)
//   pnpm --filter api invite EMAIL --disable    disable EMAIL: sign them out everywhere, refuse them from now on
//   pnpm --filter api invite --list             who is invited, and who has signed in
//
// The statements are the admin API's (src/accounts.ts): the same SQL runs from here and from the admin SPA.
//
// Local databases need their migrations first (`pnpm --filter api migrate`). `--remote` finds the deployed database and the denylist by
// name; if that fails, give their ids in CUE_D1_ID and CUE_KV_ID.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { disableAccount, denylistKey, enableAccount, inviteState, LIST_INVITES, normalizeEmail, type Statement } from '../src/accounts.ts';
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

const quote = (value: string | number | null) => (typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : String(value));

/** A shared statement with its parameters written in, for `cf d1 raw`. */
const render = ({ sql: text, params }: Statement) => {
    let next = 0;
    return text.replace(/\?/g, () => quote(params[next++] ?? null));
};

if (flag('--list')) {
    for (const row of sql(LIST_INVITES.sql)) {
        const state = inviteState({ disabled: row.disabled, user_id: row.user_id });
        console.log(`${String(row.email)}\t${state === 'accepted' ? 'signed in' : state === 'pending' ? 'invited' : 'disabled'}`);
    }
    process.exit(0);
}

const address = email ? normalizeEmail(email) : null;
if (!address) usage('Give the email address to invite.');
const known = sql(`SELECT id FROM user WHERE email = ${quote(address)}`)[0]?.id as string | undefined;

if (flag('--disable')) {
    // Revoking everything first, then the denylist: a disabled person's access tokens (valid for up to 15 minutes) stop working at once.
    sql(disableAccount(address).map(render).join(';\n'));
    if (known) run('kv', 'keys', 'put', denylistKey(known), '--namespace-id', denylistId, ...place, '--body', '1');
    console.log(`disabled ${address}${known ? '' : ' (not signed in before)'}`);
} else {
    sql(enableAccount(address).map(render).join(';\n'));
    if (known) run('kv', 'keys', 'delete', denylistKey(known), '--namespace-id', denylistId, ...place, '--force');
    console.log(`invited ${address}`);
}
