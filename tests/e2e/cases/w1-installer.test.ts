import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_ARCH, E2E_ROOT } from '../harness/config.ts';
import { assertContains, assertEq, assertTextContains, e2eCase, exec, fail, listDir, needElevation } from '../harness/index.ts';

const WINDOWS = join(E2E_ROOT, '..', '..', 'apps', 'windows');
const BUILD = join(WINDOWS, 'scripts', 'build.ps1');
const INSTALLED = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Cue');
const SHORTCUT = join(process.env['ProgramData'] ?? 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Cue.lnk');
const ARCH = E2E_ARCH;

/** The installed Cue.exe's file version, or undefined when there is none. */
async function installedVersion(): Promise<string | undefined> {
    const exe = join(INSTALLED, 'Cue.exe');
    if (!existsSync(exe)) return undefined;
    const read = await exec('powershell.exe', ['-NoProfile', '-Command', `(Get-Item '${exe}').VersionInfo.FileVersion`]);
    return read.stdout.trim();
}

/** How many Cue entries Windows' list of installed programs has (Settings › Apps). */
async function listed(): Promise<number> {
    const read = await exec('powershell.exe', [
        '-NoProfile',
        '-Command',
        "@(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' | Where-Object { $_.DisplayName -eq 'Cue' }).Count",
    ]);
    return Number(read.stdout.trim());
}

/** `build.ps1 -Msi -Quick` for `version` into `folder` (an installer only this case installs: stored, not compressed): its path. */
async function buildInstaller(version: string, folder: string): Promise<string> {
    const built = await exec(
        'powershell.exe',
        [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            BUILD,
            '-Arch',
            ARCH,
            '-Version',
            version,
            '-Msi',
            '-Quick',
            '-Output',
            folder,
        ],
        { timeout: 900 },
    );
    const made = join(folder, `Cue-${version}-${ARCH}.msi`);
    if (built.code !== 0 || !existsSync(made)) fail(`building Cue ${version} failed`, built.output);
    return made;
}

/** The installer the build made already (CI's build step, `build.ps1 -Msi`): the older of the two this case needs. */
function builtInstaller(): { version: string; path: string } | undefined {
    const found = listDir(join(WINDOWS, 'build'))
        .map((name) => ({ name, version: new RegExp(`^Cue-(\\d+\\.\\d+\\.\\d+)-${ARCH}\\.msi$`).exec(name)?.[1] }))
        .find((msi) => msi.version !== undefined);
    return found?.version === undefined ? undefined : { version: found.version, path: join(WINDOWS, 'build', found.name) };
}

e2eCase(
    'Cue for Windows: the MSI installs it per machine with a Start menu shortcut, the installed Cue signs in, a newer MSI upgrades it in place, an older one is refused, and uninstalling removes it.',
    async (cue) => {
        await needElevation();
        if (await installedVersion()) fail(`Cue is installed already (${INSTALLED}): uninstall it before running this case`);

        // Two installers, the second newer: the one the build made (the very file CI keeps), else one built here, and one built for the version
        // after it. Each is built into a folder of its own (a build clears the installers of the one before it from its output) and kept apart.
        const msi = (version: string): string => cue.path('msi', `Cue-${version}-${ARCH}.msi`);
        mkdirSync(cue.path('msi'), { recursive: true });
        const made = builtInstaller();
        const older = made?.version ?? '2.0.90';
        if (made) copyFileSync(made.path, msi(older));
        else copyFileSync(await buildInstaller(older, cue.path('build', older)), msi(older));
        const [major, minor, patch] = older.split('.').map(Number);
        const newer = `${major}.${minor}.${(patch ?? 0) + 1}`;
        copyFileSync(await buildInstaller(newer, cue.path('build', newer)), msi(newer));
        rmSync(cue.path('build'), { recursive: true, force: true });
        const msiexec = async (name: string, ...args: string[]) => {
            const ran = await exec('msiexec.exe', [...args, '/qn', '/norestart', '/l*v', cue.path(`${name}.log`)], { timeout: 600 });
            return ran.code;
        };

        try {
            // Install.
            assertEq(await msiexec('install', '/i', msi(older)), 0, 'msiexec /i');
            assertEq(await installedVersion(), `${older}.0`, `Cue.exe is in Program Files\\Cue, as ${older}`);
            assertEq(existsSync(SHORTCUT), true, 'a Start menu shortcut');
            assertEq(await listed(), 1, 'Cue is in the list of installed programs');

            // The installed Cue is a Cue: it signs in.
            await cue.launch({}, { bin: join(INSTALLED, 'Cue.exe') });
            assertContains(cue.sessionLog(), /Signed in to Cue as /);
            await cue.stop();

            // A newer one replaces it, and what the person had stays.
            assertEq(await msiexec('upgrade', '/i', msi(newer)), 0, 'the newer MSI upgrades');
            assertEq(await installedVersion(), `${newer}.0`, 'the new Cue.exe replaced the old');
            assertEq(await listed(), 1, 'still one Cue');
            await cue.launch({}, { bin: join(INSTALLED, 'Cue.exe'), signIn: false });
            await cue.waitLog(/🔑 Signed in to Cue as /, 60);
            assertEq(cue.logCount(/Sign in to Cue first/), 0, 'the upgraded Cue still had its sign-in');
            await cue.stop();

            // An older one is refused.
            assertEq((await msiexec('downgrade', '/i', msi(older))) === 0, false, 'the older MSI does not replace the newer');
            assertEq(await installedVersion(), `${newer}.0`, `still ${newer}`);
            // Windows Installer's logs are UTF-16.
            assertTextContains(readFileSync(cue.path('downgrade.log'), 'utf16le'), /A newer version of Cue is already installed/);
        } finally {
            await msiexec('uninstall', '/x', msi(newer));
        }

        // Uninstall: Cue is gone, the person's own folders are not.
        assertEq(await installedVersion(), undefined, 'Cue.exe is gone');
        assertEq(existsSync(INSTALLED), false, 'and its folder');
        assertEq(existsSync(SHORTCUT), false, 'and its shortcut');
        assertEq(await listed(), 0, 'and its entry in the list of installed programs');
        assertEq(existsSync(cue.support), true, 'what Cue kept for the person stays');
    },
);
