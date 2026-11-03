// Cue for Windows' installer in a case (w1-…): building MSIs with scripts/build.ps1, running Windows Installer, and what is installed.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_ARCH, E2E_ROOT } from './config.ts';
import { listDir } from './files.ts';
import { exec } from './process.ts';
import { fail } from './results.ts';

const WINDOWS = join(E2E_ROOT, '..', '..', 'apps', 'windows');

/** Where the MSI installs Cue (per machine). */
export const INSTALLED = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Cue');

/** The installed Cue.exe's file version ("2.0.90.0"), or undefined when there is none. */
export async function installedVersion(): Promise<string | undefined> {
    const exe = join(INSTALLED, 'Cue.exe');
    if (!existsSync(exe)) return undefined;
    const read = await exec('powershell.exe', ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.FileVersion`]);
    return read.stdout.trim();
}

/** How many Cue entries Windows' list of installed programs has (Settings › Apps). */
export async function listedPrograms(): Promise<number> {
    const read = await exec('powershell.exe', [
        '-NoProfile',
        '-Command',
        "@(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -eq 'Cue' }).Count",
    ]);
    return Number(read.stdout.trim());
}

/** `build.ps1 -Msi -Quick` for `version` into `folder` (an installer only a case installs: stored, not compressed): its path. */
export async function buildInstaller(version: string, folder: string): Promise<string> {
    const built = await exec(
        'powershell.exe',
        [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            join(WINDOWS, 'scripts', 'build.ps1'),
            '-Arch',
            E2E_ARCH,
            '-Version',
            version,
            '-Msi',
            '-Quick',
            '-Output',
            folder,
        ],
        { timeout: 900 },
    );
    const made = join(folder, `Cue-${version}-${E2E_ARCH}.msi`);
    if (built.code !== 0 || !existsSync(made)) fail(`building Cue ${version} failed`, built.output);
    return made;
}

/** The installer the build made already (CI's build step, `build.ps1 -Msi`), if there is one. */
export function builtInstaller(): { version: string; path: string } | undefined {
    const found = listDir(join(WINDOWS, 'build'))
        .map((name) => ({ name, version: new RegExp(`^Cue-(\\d+\\.\\d+\\.\\d+)-${E2E_ARCH}\\.msi$`).exec(name)?.[1] }))
        .find((msi) => msi.version !== undefined);
    return found?.version === undefined ? undefined : { version: found.version, path: join(WINDOWS, 'build', found.name) };
}

/** The version after `version` ("2.0.91" after "2.0.90"). */
export function nextVersion(version: string): string {
    const [major, minor, patch] = version.split('.').map(Number);
    return `${major}.${minor}.${(patch ?? 0) + 1}`;
}

/** Runs Windows Installer with no UI, its verbose log in `log`: its exit code. */
export async function msiexec(log: string, ...args: string[]): Promise<number> {
    const ran = await exec('msiexec.exe', [...args, '/qn', '/norestart', '/l*v', log], { timeout: 600 });
    return ran.code;
}
