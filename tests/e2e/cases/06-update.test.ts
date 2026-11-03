import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CUE_APP } from '../harness/config.ts';
import { assertContains, assertDeepEq, assertEq, e2eCase, exec, fail, listDir } from '../harness/index.ts';

/** Copies the built Cue.app to `to`; with `version`, stamps that version and signs it again, ad hoc, as the release workflow signs Cue. */
async function copyApp(to: string, version?: string): Promise<void> {
    mkdirSync(join(to, '..'), { recursive: true });
    const copied = await exec('ditto', [CUE_APP, to]);
    if (copied.code !== 0) fail(`couldn't copy Cue.app to ${to}`, copied.output);
    if (!version) return;
    await exec('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleShortVersionString ${version}`, join(to, 'Contents', 'Info.plist')]);
    const signed = await exec('codesign', ['--force', '--sign', '-', '--identifier', 'com.andriishafar.cue', to]);
    if (signed.code !== 0) fail(`couldn't sign Cue ${version}`, signed.output);
}

async function versionOf(app: string): Promise<string> {
    const read = await exec('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents', 'Info.plist')]);
    return read.stdout.trim();
}

e2eCase(
    "Cue updates itself from the latest GitHub release: a download that doesn't match the release is refused, one that does takes the place of Cue.app while Cue goes on, and Restart to Update opens the new version.",
    async (cue) => {
        // The Cue under test is a copy of the build, where the person keeps it (Applications); the release is a newer one, zipped as release.yml zips it.
        const app = cue.path('Applications', 'Cue.app');
        await copyApp(app);
        const current = await versionOf(app);
        const next = '99.0.0';
        await copyApp(cue.path('release', 'Cue.app'), next);
        const zip = cue.path('release', `Cue-${next}.zip`);
        const zipped = await exec('ditto', ['-c', '-k', '--keepParent', cue.path('release', 'Cue.app'), zip]);
        if (zipped.code !== 0) fail('ditto failed', zipped.output);

        // A release whose file isn't the one it describes (changed on the way): refused when Cue opens, and Cue.app stays as it was.
        const releases = await cue.releases();
        await releases.publish({ version: next, files: [zip], wrongDigest: true });
        await cue.launch({ CUE_UPDATE_URL: releases.url }, { bin: join(app, 'Contents', 'MacOS', 'Cue'), signIn: false });
        await cue.waitLog(new RegExp(`⚠︎ Couldn't update Cue: the download of Cue-${next}\\.zip doesn't match the release`), 60);
        assertEq(await versionOf(app), current, 'Cue.app is still the one it was');

        // The release as it is: Check for Updates downloads it, checks it and puts it in place of Cue.app; the running Cue goes on.
        await releases.publish({ version: next, files: [zip] });
        cue.control('update check');
        await cue.waitLog(new RegExp(`✅ Cue ${next} is installed: it opens the next time Cue starts`), 120);
        assertContains(cue.sessionLog(), new RegExp(`🔄 Downloading Cue ${next} \\(this is ${current}\\)…`));
        assertEq(await versionOf(app), next, 'Cue.app is the new version');
        const verified = await exec('codesign', ['--verify', '--deep', '--strict', app]);
        assertEq(verified.code, 0, `the new Cue.app's signature is valid (${verified.output.trim()})`);
        assertEq(cue.alive(), true, 'the running Cue goes on');
        assertDeepEq(listDir(join(cue.support, 'updates')), ['installed.json'], 'only the note of the update is left of the download');

        // Restart to Update: this Cue quits, the new one opens, says it was updated, and finds itself up to date.
        cue.control('update restart');
        await cue.followRestart(join(app, 'Contents', 'MacOS', 'Cue'), 60);
        await cue.waitLog(new RegExp(`✅ Cue was updated from ${current} to ${next}`), 30);
        await cue.waitLog(new RegExp(`✅ Cue is up to date \\(${next}\\)`), 30);
        assertEq(listDir(join(cue.support, 'updates')).length, 0, 'nothing of the update is left');
        assertEq(
            releases.requests.filter((request) => request.includes('/download/')).length,
            2,
            'the release was downloaded twice, not again after the restart',
        );
    },
);
