import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_ARCH, E2E_ROOT } from '../harness/config.ts';
import { assertContains, assertEq, assertTextContains, e2eCase, exec, fail, needElevation } from '../harness/index.ts';

const BUILD = join(E2E_ROOT, '..', '..', 'apps', 'windows', 'scripts', 'build.ps1');
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

e2eCase(
    'Cue for Windows: the MSI installs it per machine with a Start menu shortcut, the installed Cue signs in, a newer MSI upgrades it in place, an older one is refused, and uninstalling removes it.',
    async (cue) => {
        await needElevation();
        if (await installedVersion()) fail(`Cue is installed already (${INSTALLED}): uninstall it before running this case`);

        // Two builds of the installer, the second newer. Each gets a folder of its own (a build clears the installers of the one before it from its
        // output) and its MSI is kept apart.
        const msi = (version: string): string => cue.path('msi', `Cue-${version}-${ARCH}.msi`);
        mkdirSync(cue.path('msi'), { recursive: true });
        for (const version of ['2.0.90', '2.0.91']) {
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
                    '-Output',
                    cue.path('build', version),
                ],
                { timeout: 900 },
            );
            const made = cue.path('build', version, `Cue-${version}-${ARCH}.msi`);
            if (built.code !== 0 || !existsSync(made)) fail(`building Cue ${version} failed`, built.output);
            copyFileSync(made, msi(version));
            rmSync(cue.path('build', version), { recursive: true, force: true });
        }
        const msiexec = async (name: string, ...args: string[]) => {
            const ran = await exec('msiexec.exe', [...args, '/qn', '/norestart', '/l*v', cue.path(`${name}.log`)], { timeout: 600 });
            return ran.code;
        };

        try {
            // Install.
            assertEq(await msiexec('install', '/i', msi('2.0.90')), 0, 'msiexec /i');
            assertEq(await installedVersion(), '2.0.90.0', 'Cue.exe is in Program Files\\Cue, as 2.0.90');
            assertEq(existsSync(SHORTCUT), true, 'a Start menu shortcut');
            assertEq(await listed(), 1, 'Cue is in the list of installed programs');

            // The installed Cue is a Cue: it signs in.
            await cue.launch({}, { bin: join(INSTALLED, 'Cue.exe') });
            assertContains(cue.sessionLog(), /Signed in to Cue as /);
            await cue.stop();

            // A newer one replaces it, and what the person had stays.
            assertEq(await msiexec('upgrade', '/i', msi('2.0.91')), 0, 'the newer MSI upgrades');
            assertEq(await installedVersion(), '2.0.91.0', 'the new Cue.exe replaced the old');
            assertEq(await listed(), 1, 'still one Cue');
            await cue.launch({}, { bin: join(INSTALLED, 'Cue.exe'), signIn: false });
            await cue.waitLog(/🔑 Signed in to Cue as /, 60);
            assertEq(cue.logCount(/Sign in to Cue first/), 0, 'the upgraded Cue still had its sign-in');
            await cue.stop();

            // An older one is refused.
            assertEq((await msiexec('downgrade', '/i', msi('2.0.90'))) === 0, false, 'the older MSI does not replace the newer');
            assertEq(await installedVersion(), '2.0.91.0', 'still 2.0.91');
            // Windows Installer's logs are UTF-16.
            assertTextContains(readFileSync(cue.path('downgrade.log'), 'utf16le'), /A newer version of Cue is already installed/);
        } finally {
            await msiexec('uninstall', '/x', msi('2.0.91'));
        }

        // Uninstall: Cue is gone, the person's own folders are not.
        assertEq(await installedVersion(), undefined, 'Cue.exe is gone');
        assertEq(existsSync(INSTALLED), false, 'and its folder');
        assertEq(existsSync(SHORTCUT), false, 'and its shortcut');
        assertEq(await listed(), 0, 'and its entry in the list of installed programs');
        assertEq(existsSync(cue.support), true, 'what Cue kept for the person stays');
    },
);
