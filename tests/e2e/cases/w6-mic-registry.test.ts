import { assertEq, assertNotContains, e2eCase, exec, sleep } from '../harness/index.ts';

const STORE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone';
// A program that is not installed (its path, with # for \) and a package that is not either: what the consent store keeps for every app that opened the microphone.
const PROGRAM = `${STORE}\\NonPackaged\\C:#Cue#E2E#zoom.exe`;
const PACKAGE = `${STORE}\\Cisco.Webex_e2e0123456789`;

/** A time as the consent store keeps it: a FILETIME, 100 ns since 1601. */
const filetime = (): string => (BigInt(Date.now()) * 10_000n + 116_444_736_000_000_000n).toString();

async function reg(...args: string[]): Promise<void> {
    await exec('reg.exe', args);
}

/** The app opens the microphone (stop is 0 while it has it) or lets go of it (stop is a time). */
async function using(key: string, on: boolean): Promise<void> {
    await reg('add', key, '/v', 'LastUsedTimeStart', '/t', 'REG_QWORD', '/d', filetime(), '/f');
    await reg('add', key, '/v', 'LastUsedTimeStop', '/t', 'REG_QWORD', '/d', on ? '0' : filetime(), '/f');
}

e2eCase(
    'Cue for Windows: what has the microphone is read from Windows’ own record of it (its consent store, for a program that is installed and for a Store app), ' +
        'not only from a file: a call app on it is offered for recording, and letting go of it ends that call.',
    async (cue) => {
        await reg('delete', PROGRAM, '/f');
        await reg('delete', PACKAGE, '/f');
        try {
            // CUE_MIC_APPS empty: not the test file, the registry.
            await cue.launch({ CUE_MEETING_TICK: '0.5', CUE_MIC_RELEASE: '2', CUE_MIC_APPS: '' });
            await sleep(2);
            assertNotContains(cue.sessionLog(), /🔔/, 'nothing to ask while no call app uses the microphone');

            // A program that is installed, taking the microphone.
            await using(PROGRAM, true);
            await cue.waitLog(/🔔 Record “Zoom call”\?/, 15);
            cue.control('notification dismiss');
            await cue.waitLog(/🔔 Not now: “Zoom call”/, 5);

            // It lets go; after the release window the next call in it is asked about again.
            await using(PROGRAM, false);
            await sleep(3);
            await using(PROGRAM, true);
            await cue.waitFor('the next Zoom call to be offered', 15, () => cue.logCount(/🔔 Record “Zoom call”/) === 2);
            cue.control('notification dismiss');
            await using(PROGRAM, false);

            // An app of the Store (a package) is a key of its own.
            await using(PACKAGE, true);
            await cue.waitLog(/🔔 Record “Webex call”\?/, 15);
            assertEq(cue.logCount(/🔔 Record “Webex call”/), 1);
            await using(PACKAGE, false);
        } finally {
            await reg('delete', PROGRAM, '/f');
            await reg('delete', PACKAGE, '/f');
        }
    },
);
