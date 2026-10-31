// Applies the migrations to the local database (`cf dev`'s, in .cloudflare/state or CUE_STATE_DIR). Deploys apply theirs through `cf deploy`.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DEV_DB_ID } from '../dev-ids.ts';

const root = join(import.meta.dirname, '..');
const ran = spawnSync(
    join(root, 'node_modules', '.bin', 'cf'),
    ['d1', 'migrations', 'apply', DEV_DB_ID, '--local', '--persist-to', process.env.CUE_STATE_DIR ?? '.cloudflare/state'],
    { cwd: root, stdio: 'inherit', env: { ...process.env, CI: '1' } },
);
process.exit(ran.status ?? 1);
