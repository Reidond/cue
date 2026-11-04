// How the scripts, and the end-to-end suite's backends and admins, run `cf`: a Node script, started by node itself, so that it works on Windows too
// (pnpm's `.bin/cf` there is a .cmd shim). pnpm's shim also puts the packages it hoists on NODE_PATH, which Vite plugins resolve by name from the
// app's folder (the admin's React Compiler plugin, from apps/admin): started this way, that is done here.
import { delimiter, join } from 'node:path';

const apps = join(import.meta.dirname, '..', '..');

/** One of the two Workers: `api` (cue-api) or `admin` (cue-admin). */
export type App = 'api' | 'admin';

/** The `cf` command's script of `app` (run it with `process.execPath`). */
export const cfBinOf = (app: App) => join(apps, app, 'node_modules', 'cf', 'bin', 'cf');

/** The `cf` command's script (run it with `process.execPath`). */
export const cfBin = cfBinOf('api');

/** The environment `cf` runs in for `app`: this one, `CI` (no prompts), what the pnpm shim would add to NODE_PATH, and `extra`. */
export function cfEnv(extra: NodeJS.ProcessEnv = {}, app: App = 'api'): NodeJS.ProcessEnv {
    const nodePath = [join(apps, '..', 'node_modules', '.pnpm', 'node_modules'), join(apps, app, 'node_modules'), process.env.NODE_PATH]
        .filter(Boolean)
        .join(delimiter);
    return { ...process.env, CI: '1', NODE_PATH: nodePath, ...extra };
}
