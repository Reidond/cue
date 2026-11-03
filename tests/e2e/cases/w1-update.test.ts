import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { E2E_ARCH } from '../harness/config.ts';
import {
    assertDeepEq,
    assertEq,
    buildInstaller,
    builtInstaller,
    e2eCase,
    fail,
    INSTALLED,
    installedVersion,
    listDir,
    listedPrograms,
    msiexec,
    needElevation,
    nextVersion,
} from '../harness/index.ts';

e2eCase(
    'Cue for Windows updates itself from the latest GitHub release: the installed Cue downloads the newer MSI and checks it, and Restart to Update installs it and opens the new Cue, which says it was updated.',
    async (cue) => {
        await needElevation();
        if (await installedVersion()) fail(`Cue is installed already (${INSTALLED}): uninstall it before running this case`);

        // The installed Cue: the installer the build made (the very file CI keeps), else one built here. The release: one built for the version after it.
        const msi = (version: string): string => cue.path('msi', `Cue-${version}-${E2E_ARCH}.msi`);
        mkdirSync(cue.path('msi'), { recursive: true });
        const made = builtInstaller();
        const older = made?.version ?? '2.0.90';
        if (made) copyFileSync(made.path, msi(older));
        else copyFileSync(await buildInstaller(older, cue.path('build', older)), msi(older));
        const newer = nextVersion(older);
        copyFileSync(await buildInstaller(newer, cue.path('build', newer)), msi(newer));
        rmSync(cue.path('build'), { recursive: true, force: true });
        const exe = join(INSTALLED, 'Cue.exe');

        try {
            assertEq(await msiexec(cue.path('install.log'), '/i', msi(older)), 0, 'msiexec /i');
            assertEq(await installedVersion(), `${older}.0`, `Cue ${older} is installed`);

            // The latest release is the newer one: the installed Cue downloads it when it opens, checks it, and keeps it for the restart.
            const releases = await cue.releases();
            await releases.publish({ version: newer, files: [msi(newer)] });
            await cue.launch({ CUE_UPDATE_URL: releases.url }, { bin: exe, signIn: false });
            await cue.waitLog(new RegExp(`🔄 Downloading Cue ${newer} \\(this is ${older}\\)…`), 60);
            await cue.waitLog(new RegExp(`✅ Cue ${newer} is downloaded: it installs when Cue restarts`), 300);
            assertEq(await installedVersion(), `${older}.0`, 'nothing is installed while Cue runs');

            // Restart to Update: Cue quits, Windows Installer puts the new version in place, and the new Cue opens.
            cue.control('update restart');
            await cue.followRestart(exe, 600);
            await cue.waitLog(new RegExp(`✅ Cue was updated from ${older} to ${newer}`), 60);
            await cue.waitLog(new RegExp(`✅ Cue is up to date \\(${newer}\\)`), 60);
            assertEq(await installedVersion(), `${newer}.0`, `Cue ${newer} is installed`);
            assertEq(await listedPrograms(), 1, 'still one Cue in the list of installed programs');
            assertDeepEq(listDir(join(cue.support, 'updates')), [], 'nothing of the update is left');
            assertEq(releases.requests.filter((request) => request.includes('/download/')).length, 1, 'the installer was downloaded once');
        } finally {
            await cue.stop();
            for (const version of [newer, older]) await msiexec(cue.path(`uninstall-${version}.log`), '/x', msi(version));
        }
        assertEq(await installedVersion(), undefined, 'Cue is uninstalled');
    },
);
