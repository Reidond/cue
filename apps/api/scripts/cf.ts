// How the scripts, and the end-to-end suite's backends, run `cf`: a Node script, started by node itself, so that it works on Windows too (pnpm's
// `.bin/cf` there is a .cmd shim). pnpm's shim also puts the packages it hoists on NODE_PATH, which Vite plugins resolve by name from the app's
// folder (the admin's React Compiler plugin, from apps/api): started this way, that is done here.
import { delimiter, join } from 'node:path';

const root = join(import.meta.dirname, '..');

/** The `cf` command's script (run it with `process.execPath`). */
export const cfBin = join(root, 'node_modules', 'cf', 'bin', 'cf');

/** The environment `cf` runs in: this one, `CI` (no prompts), what the pnpm shim would add to NODE_PATH, and `extra`. */
export function cfEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    const nodePath = [join(root, '..', '..', 'node_modules', '.pnpm', 'node_modules'), join(root, 'node_modules'), process.env.NODE_PATH]
        .filter(Boolean)
        .join(delimiter);
    return { ...process.env, CI: '1', NODE_PATH: nodePath, ...extra };
}
