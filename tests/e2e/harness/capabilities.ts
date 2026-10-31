// What some cases depend on and some Macs can't do: draw snapshots of Cue's windows and of its overlay
// that Vision can read. GitHub's macOS runners draw the hidden overlay (rendered offscreen) blank while
// capturing the dashboard fine. The runner (run.ts) probes each once per run, before the cases, and a
// case that depends on one skips with the measured reason (requirements.ts) instead of timing out.
// (Speech is the backend's: no case needs a machine that can recognize it.)
import { writeFile } from 'node:fs/promises';
import { linesOf, nonEmpty, readText } from './files.ts';
import type { Capabilities } from './requirements.ts';
import { Cue } from './sandbox.ts';
import { ocr } from './screen.ts';
import { sleep } from './time.ts';

/**
 * Whether Cue's snapshots read as text: its windows (the dashboard) and, separately, the overlay
 * once Start Cue has shown it, which is drawn another way (all glass, floating over the desktop).
 */
export async function probeSnapshots(): Promise<Pick<Capabilities, 'windows' | 'overlay'>> {
    const cue = await Cue.open('00-probe-snapshots');
    let dashboard = '',
        overlay = '';
    const windowsRead = (): boolean => /New Project/i.test(dashboard);
    const overlayRead = (): boolean => /Listening|No audio|When someone asks|Drop your|Ask anything/i.test(overlay);
    try {
        await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png') });
        // The dashboard opens at launch, on Home; Start Cue on a new project shows the overlay.
        cue.control('new Probe');
        cue.control('start Probe');
        const shown = Date.now() + 1000;
        for (const deadline = Date.now() + 30_000; Date.now() < deadline && !(windowsRead() && overlayRead()); await sleep(2)) {
            if (!windowsRead() && nonEmpty(cue.path('cue-dashboard.png'))) dashboard = await ocr(cue.path('cue-dashboard.png'));
            if (!overlayRead() && Date.now() > shown && nonEmpty(cue.path('cue.png'))) overlay = await ocr(cue.path('cue.png'));
        }
        const log = linesOf(readText(cue.sessionLog()) ?? '');
        const logged = (pattern: RegExp): string | undefined => log.map((line) => pattern.exec(line)?.[1]).find(Boolean);
        const windowsMethod = logged(/📸 Snapshots: (.*)/) ?? 'capture method not logged';
        const overlayMethod = logged(/📸 Overlay: (.*)/) ?? windowsMethod;
        const unreadable = (text: string, method: string): string =>
            `${text.trim() ? 'not the expected text' : 'no text'} in its snapshots here (${method})`;
        return {
            windows: windowsRead()
                ? { ok: true, detail: windowsMethod }
                : { ok: false, detail: `the dashboard shows ${unreadable(dashboard, windowsMethod)}` },
            overlay: overlayRead()
                ? { ok: true, detail: overlayMethod }
                : { ok: false, detail: `the overlay shows ${unreadable(overlay, overlayMethod)}` },
        };
    } finally {
        await cue.close(windowsRead() && overlayRead());
    }
}

/**
 * Probes what the cases about to run need, writes the results where requirements.ts reads them
 * (the file E2E_CAPABILITIES names) and returns them.
 */
export async function probeMachine(needs: ReadonlySet<'snapshots'>, file: string): Promise<Capabilities> {
    const found: Capabilities = {};
    if (needs.has('snapshots')) Object.assign(found, await probeSnapshots());
    await writeFile(file, JSON.stringify(found, null, 2));
    return found;
}
