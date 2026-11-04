#!/usr/bin/env node
// Builds and tests Cue where they belong, from this Mac, which builds and tests nothing itself: Cue for macOS is built and every case runs
// in the Cue macOS VM, Cue for Windows in the Cue Windows VM (VMPal's, one of each, which this script makes the first time and every
// checkout and agent reuses after), and the backend is built and checked in this checkout's Boat sandbox.
//
//   node tests/e2e/remote.ts mac|windows|boat [--admin] [COMMAND…]
//   node tests/e2e/remote.ts mac|windows|boat stop
//   node tests/e2e/remote.ts status
//
//   COMMAND      what to run in this checkout's copy there, once the copy is this checkout (its tracked files and the untracked ones git
//                doesn't ignore: uncommitted work goes too); without one, only that
//   e2e ARGS…    node tests/e2e/run.ts ARGS…, in a VM (`mac e2e --no-app 9a-` for the backend's own cases); the cases' logs come back
//                into this checkout's folder in $TMPDIR
//   check        pnpm vp check; `check --fix` brings what it fixed back into this checkout
//   cua ARGS…    Cua Driver's command line in a VM (cua-driver ARGS…), at once, with no copy: `cua call list_apps`, `cua call
//                get_window_state '{"pid":…,"window_id":…}' --screenshot-out-file shot.png` (the screenshot comes to this Mac), `cua list-tools`
//   --admin      as administrator: root on macOS and Linux, elevated on Windows (w1-, which installs the MSI)
//   stop         suspend the VM, or stop the sandbox (its disk is kept): the next command starts it again
//   status       the machines, and where this checkout is on each
//
// The first time, the VM is made (macOS: a 27 GB download and about an hour; Windows: 5 GB and half an hour), the toolchain installed
// (apps/mac/scripts/setup.sh, with this Mac's Xcode; apps/windows/scripts/setup.ps1; tests/e2e/tools/setup-linux.sh; and in the VMs Cua
// Driver, tests/e2e/tools/cua-driver.sh and .ps1) and the VM snapshotted as `cue-toolchain-HASH`.
// After that the toolchain is installed again when one of its scripts changes, and the packages when pnpm-lock.yaml does. Each checkout has a
// folder of its own on each VM (C:\cue\ID on Windows, ~/cue/ID on the Mac) and a sandbox of its own on Boat, so worktrees don't
// overwrite each other; a VM runs two commands at a time at most.
//
// Exit status: the command's; 1 when the machine couldn't be made ready, 2 for a wrong command line.
import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { shellQuote } from './harness/process.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
// As run.ts names a checkout's work folder.
const checkout = createHash('sha1').update(`${ROOT}\n`).digest('hex').slice(0, 8);
const local = join(process.env['TMPDIR'] || tmpdir(), `cue-remote-${checkout}`);
// The Boat CLI updates itself as it runs, unless told not to, and says so where this script reads its answers.
process.env['BOAT_NO_UPDATE'] ??= '1';

type Target = 'mac' | 'windows' | 'boat';

/** The VMs: found by name, made with these settings when there is none. */
const VMS = {
    mac: { name: 'Cue macOS', system: 'download:macOS', cpus: 6, memoryGB: 12, diskGB: 150 },
    windows: { name: 'Cue Windows', system: 'download:windows', cpus: 6, memoryGB: 10, diskGB: 150 },
} as const;
const SNAPSHOT = 'cue-toolchain';
const BOAT_NAME = `cue-${basename(ROOT)}-${checkout}`.slice(0, 120);
/** What a sync leaves alone in a checkout's copy: what builds and installs make there (as .gitignore has it). */
const KEPT = ['node_modules', 'build', '.build', '.swiftpm', '.cloudflare', 'bin', 'obj', '.vs'];

function usage(): string {
    const lines = readFileSync(import.meta.filename, 'utf8').split('\n');
    return lines
        .slice(
            1,
            lines.findIndex((line, index) => index > 0 && !line.startsWith('//')),
        )
        .map((line) => line.replace(/^\/\/ ?/, ''))
        .join('\n');
}

function say(line: string): void {
    console.log(`▸ ${line}`);
}

function die(message: string): never {
    console.error(message);
    process.exit(1);
}

/** Runs a program with this terminal: its status. */
function run(command: string, args: readonly string[], options: SpawnSyncOptions = {}): number {
    const ran = spawnSync(command, args, { stdio: 'inherit', ...options });
    if (ran.error) die(`Couldn't run ${command}: ${ran.error.message}`);
    return ran.status ?? 128;
}

/** Runs a program and keeps what it printed; dies when it fails, saying why, unless `allowFailure`. */
function capture(command: string, args: readonly string[], allowFailure = false): { code: number; stdout: string } {
    const ran = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (ran.error) die(`Couldn't run ${command}: ${ran.error.message}`);
    const code = ran.status ?? 128;
    if (code !== 0 && !allowFailure) die(`${command} ${args.join(' ')} failed (${code}):\n${ran.stderr}${ran.stdout}`);
    return { code, stdout: ran.stdout };
}

function sleep(seconds: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function onPath(name: string): boolean {
    return (process.env['PATH'] ?? '').split(delimiter).some((folder) => folder !== '' && existsSync(join(folder, name)));
}

function hash(...parts: string[]): string {
    const sha = createHash('sha256');
    for (const part of parts) sha.update(`${part}\n`);
    return sha.digest('hex').slice(0, 16);
}

const fileHash = (...paths: string[]): string => hash(...paths.map((path) => readFileSync(join(ROOT, path), 'utf8')));
const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
/** The checkout's files as they were sent, by their digests (what `check --fix` compares with). */
const sent = new Map<string, string>();

// VMPal's command line, on the PATH when linked there (`vmpal help setup`), else inside VMPal.
const VMPAL_APP = '/Applications/VMPal.app/Contents/Helpers/VMPalMachine.app/Contents/MacOS/VMPalMachine';
const vmpalCommand = onPath('vmpal') ? ['vmpal'] : existsSync(VMPAL_APP) ? [VMPAL_APP, '--cli'] : [];

/** Runs vmpal with this terminal (`quiet`: what it prints is dropped, but for errors): its status. */
function vmpal(args: readonly string[], quiet = false): number {
    if (vmpalCommand.length === 0) die('VMPal is not installed (/Applications/VMPal.app)');
    const [command = '', ...prefix] = vmpalCommand;
    return run(command, [...prefix, ...args], quiet ? { stdio: ['ignore', 'ignore', 'inherit'] } : {});
}

function vmpalOut(args: readonly string[], allowFailure = false): { code: number; stdout: string } {
    if (vmpalCommand.length === 0) die('VMPal is not installed (/Applications/VMPal.app)');
    const [command = '', ...prefix] = vmpalCommand;
    return capture(command, [...prefix, ...args], allowFailure);
}

interface VmRow {
    id: string;
    name: string;
    state: string;
    activity: unknown;
    agentControl: boolean;
    pendingSettings: string[];
}

function vms(): VmRow[] {
    return (JSON.parse(vmpalOut(['list', '--json']).stdout) as { vms: VmRow[] }).vms;
}

function toolsConnected(vm: VmRow): boolean {
    return (JSON.parse(vmpalOut(['info', vm.id, '--json']).stdout) as { tools?: { connected?: boolean } }).tools?.connected === true;
}

/**
 * Runs VMPal Tools' installer, which VMPal shares with every VM, through the Mac VM's screen. VMPal puts its Tools in a new macOS over the
 * network, which fails when the VM had none while it was set up (on some Macs the shared network gives it no address).
 */
function installTools(vm: VmRow): void {
    say(`VMPal couldn't put its Tools in ${vm.name}: running their installer there`);
    const steps = [
        // The desktop, so Finder is in front; Go to Folder with the installer shows it selected; Open.
        ['click', '1200', '450'],
        ['key', 'super+shift+g'],
        ['wait', '1'],
        ['type', '/Volumes/My Shared Files/VMPal Tools/Install VMPal Tools.app\n'],
        ['wait', '2'],
        ['key', 'super+o'],
    ];
    for (const step of steps) vmpal(['ui', vm.id, ...step, '--mask', 'Installing VMPal Tools'], true);
}

/**
 * Administrator commands in a Mac VM need VMPal Tools' administrator part, which macOS's own prompt allows: once, and again after VMPal Tools
 * update. VMPal Tools ask for it (`--authorize-agents`) and VMPal types the password it keeps for the VM into the prompt; it never passes here.
 */
async function allowAdmin(vm: VmRow, home: string): Promise<void> {
    const admin = (): boolean => vmpalOut(['exec', vm.id, '--admin', '--', '/usr/bin/true'], true).code === 0;
    if (admin()) return;
    say(`Allowing administrator commands in ${vm.name}`);
    const [command = '', ...prefix] = vmpalCommand;
    const tools = `${home}/Library/Application Support/VMPal Tools/VMPal Tools.app/Contents/MacOS/VMPal Tools`;
    const asking = spawn(command, [...prefix, 'exec', vm.id, '--timeout', '5m', '--', tools, '--authorize-agents'], { stdio: 'ignore' });
    const asked = new Promise((done) => asking.on('close', done));
    for (let waited = 0; waited < 60; waited += 2) {
        sleep(2);
        if (/No text/.test(vmpalOut(['ui', vm.id, 'observe', '--find', 'administrator access'], true).stdout)) continue;
        const typed = vmpalOut(['tool', 'vmpal_type_password', JSON.stringify({ vm: vm.id })], true).stdout;
        if (!/"result":"accepted"/.test(typed)) die(`VMPal couldn't allow administrator commands in ${vm.name}: ${typed}`);
        break;
    }
    await asked;
    for (let waited = 0; waited < 60 && !admin(); waited += 5) sleep(5);
    if (!admin()) die(`Administrator commands don't run in ${vm.name}: allow them in VMPal Tools' Settings › AI Agents there`);
}

const quotePs = (word: string): string => `'${word.replaceAll("'", "''")}'`;

/** A machine this checkout runs on: how to run a script in its copy, and how files get there and back. */
interface Machine {
    target: Target;
    /** Where the checkouts' copies are, and the toolchain's marker. */
    base: string;
    /** The checkout's copy there, as a shell there writes it. */
    dir: string;
    windows: boolean;
    /** Runs a script (a POSIX shell's, or PowerShell's on Windows) in the copy; with `admin`, as administrator. Its status. */
    script(body: string, options?: { admin?: boolean; quiet?: boolean }): Promise<number>;
    /** What a script printed, or undefined when it failed. */
    output(body: string): string | undefined;
    /** Brings the copy up to date with this checkout. */
    sync(): Promise<void>;
    /** Copies a file of the machine's to this Mac. */
    fetch(from: string, to: string): boolean;
}

/** A command as a script line: a POSIX shell's, or PowerShell's. */
function commandLine(windows: boolean, command: readonly string[]): string {
    return windows
        ? `& ${command.map(quotePs).join(' ')}; exit $LASTEXITCODE`
        : `exec ${command.map((word) => shellQuote(word)).join(' ')}`;
}

/** A PowerShell command line for the Windows VM: with the Path an installer just changed (VMPal Tools started before it), in the copy. */
function powershell(dir: string, body: string): string[] {
    const prelude = [
        `$ProgressPreference = 'SilentlyContinue'`,
        `$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')`,
        `if (Test-Path -LiteralPath ${quotePs(dir)}) { Set-Location -LiteralPath ${quotePs(dir)} }`,
    ].join('; ');
    return ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `${prelude}; ${body}`];
}

/** A POSIX shell script that makes the copy what `incoming` holds, leaving KEPT alone. */
function mirror(incoming: string, dir: string): string {
    return [
        'set -e',
        `mkdir -p ${shellQuote(dir)}`,
        `rsync -a --delete ${KEPT.map((name) => `--exclude=${name}`).join(' ')} --exclude='.dev.vars*' ${shellQuote(`${incoming}/`)} ${shellQuote(`${dir}/`)}`,
        `rm -rf ${shellQuote(incoming)}`,
    ].join('\n');
}

/** The VM for a target: made the first time, started (in the background, with no window) when it isn't running, signed in. */
function vmFor(target: 'mac' | 'windows'): VmRow {
    const spec = VMS[target];
    let vm = vms().find((row) => row.name === spec.name);
    if (vm === undefined) {
        say(
            `Making the ${spec.name} VM, once: ${target === 'mac' ? 'macOS downloads 27 GB and installs in about an hour' : 'Windows downloads 5 GB and installs in half an hour'}`,
        );
        const created = vmpal([
            'create',
            spec.system,
            '--name',
            spec.name,
            '--cpus',
            String(spec.cpus),
            '--memory',
            String(spec.memoryGB),
            '--disk',
            String(spec.diskGB),
            // A new Mac's VMPal Tools may not come by themselves (installTools), so it is waited for only until it's installed.
            ...(target === 'windows' ? ['--sign-in-automatically', '--wait'] : []),
            '--timeout',
            '6h',
        ]);
        vm = vms().find((row) => row.name === spec.name);
        if (created !== 0 || vm === undefined) die(`Couldn't make the ${spec.name} VM`);
        if (target === 'mac' && vmpal(['wait', vm.id, '--until', 'installed', '--timeout', '6h']) !== 0)
            die(`${spec.name} wasn't installed`);
    }
    if (!vm.agentControl) die(`${spec.name} doesn't allow agent control: vmpal set ${shellQuote(spec.name)} --agent-control on`);
    // A VM saving its session, shutting down or starting is let finish first.
    for (let waited = 0; vm.activity !== null && waited < 600; waited += 5) {
        sleep(5);
        vm = vms().find((row) => row.id === vm?.id) ?? vm;
    }
    if (vm.state !== 'running') {
        say(`Starting ${spec.name}`);
        if (vmpal(['start', vm.id, '--background', '--timeout', '10m']) !== 0) die(`Couldn't start ${spec.name}`);
    } else if (vm.pendingSettings.length > 0) {
        // A new VM is put on the network VMPal's settings give every VM only once it is set up, at its next start.
        say(`Restarting ${spec.name} for its new settings (${vm.pendingSettings.join(', ')})`);
        if (vmpal(['restart', vm.id, '--apply-settings', '--timeout', '10m']) !== 0) die(`Couldn't restart ${spec.name}`);
    }
    let ready = vmpal(['wait', vm.id, '--until', 'ready', '--timeout', target === 'mac' ? '5m' : '15m']) === 0;
    if (!ready && target === 'mac' && !toolsConnected(vm)) {
        installTools(vm);
        ready = vmpal(['wait', vm.id, '--until', 'ready', '--timeout', '10m']) === 0;
    }
    if (!ready) die(`${spec.name} can't run commands`);
    return vm;
}

function vmMachine(target: 'mac' | 'windows'): Machine {
    const vm = vmFor(target);
    const windows = target === 'windows';
    const execArgs = (admin: boolean): string[] => ['exec', vm.id, ...(admin ? ['--admin'] : []), '--timeout', '24h', '--'];
    // The account's home, which a VM path is relative to.
    const home = windows
        ? ''
        : vmpalOut([...execArgs(false), '/bin/sh', '-c', 'printf %s "$HOME"']).stdout.trim() ||
          die(`${VMS[target].name} didn't say where its home is`);
    const base = windows ? 'C:\\cue' : `${home}/cue`;
    const dir = windows ? `${base}\\${checkout}` : `${base}/${checkout}`;
    // A login shell has /usr/local/bin, where setup.sh puts Node.js and pnpm.
    const argv = (body: string): string[] =>
        windows ? powershell(dir, body) : ['/bin/zsh', '-lc', `cd ${shellQuote(dir)} 2>/dev/null; ${body}`];
    const script = async (body: string, { admin = false, quiet = false } = {}): Promise<number> => {
        if (admin && !windows) await allowAdmin(vm, home);
        return vmpal([...execArgs(admin), ...argv(body)], quiet);
    };
    return {
        target,
        base,
        dir,
        windows,
        script,
        output: (body) => {
            const ran = vmpalOut([...execArgs(false), ...argv(body)], true);
            return ran.code === 0 ? ran.stdout : undefined;
        },
        sync: async () => {
            const incoming = `${dir}.incoming`,
                tar = `${dir}.tar`;
            if (
                (await script(
                    windows ? `$null = New-Item -ItemType Directory -Force -Path ${quotePs(base)}` : `mkdir -p ${shellQuote(base)}`,
                )) !== 0
            )
                die(`Couldn't make ${base} in ${vm.name}`);
            if (vmpal(['cp', tarball(), `${vm.id}:${tar}`]) !== 0) die(`Couldn't copy the checkout into ${vm.name}`);
            const mirrored = await script(
                windows
                    ? [
                          `if (Test-Path -LiteralPath ${quotePs(incoming)}) { Remove-Item -LiteralPath ${quotePs(incoming)} -Recurse -Force }`,
                          `$null = New-Item -ItemType Directory -Path ${quotePs(incoming)}`,
                          `tar.exe -xf ${quotePs(tar)} -C ${quotePs(incoming)}`,
                          `if ($LASTEXITCODE -ne 0) { exit 1 }`,
                          // /XD keeps those folders out of the copy and out of /MIR's deletions alike.
                          `$null = robocopy ${quotePs(incoming)} ${quotePs(dir)} /MIR /XD ${KEPT.join(' ')} /XF .dev.vars* /NFL /NDL /NJH /NJS /NP`,
                          `if ($LASTEXITCODE -ge 8) { Write-Output ('robocopy failed: ' + $LASTEXITCODE); exit 1 }`,
                          `Remove-Item -LiteralPath ${quotePs(incoming)}, ${quotePs(tar)} -Recurse -Force; exit 0`,
                      ].join('; ')
                    : [
                          'set -e',
                          `rm -rf ${shellQuote(incoming)}`,
                          `mkdir -p ${shellQuote(incoming)}`,
                          `tar -xf ${shellQuote(tar)} -C ${shellQuote(incoming)}`,
                          `rm -f ${shellQuote(tar)}`,
                          mirror(incoming, dir),
                      ].join('\n'),
            );
            if (mirrored !== 0) die(`Couldn't bring ${dir} in ${vm.name} up to date`);
        },
        fetch: (from, to) => vmpal(['cp', `${vm.id}:${from}`, to], true) === 0,
    };
}

interface Sandbox {
    id: string;
    name: string | null;
    state: string;
}

function sandboxes(): Sandbox[] {
    return (JSON.parse(capture('boat', ['list', '--all', '--json']).stdout) as { sandboxes: Sandbox[] }).sandboxes;
}

/** This checkout's Boat sandbox: made the first time, resumed when it was stopped. */
function sandbox(): Sandbox {
    if (!onPath('boat')) die('The Boat CLI is not installed: https://docs.boat.dev');
    let box = sandboxes().find((row) => row.name === BOAT_NAME);
    if (box === undefined) {
        say(`Making the Boat sandbox ${BOAT_NAME}`);
        const made = capture('boat', ['new', '--name', BOAT_NAME, '--json']).stdout;
        const ready = made
            .split('\n')
            .filter((line) => line.startsWith('{'))
            .map((line) => JSON.parse(line) as { event?: string; id?: string })
            .find((event) => event.event === 'ready');
        box = sandboxes().find((row) => row.id === ready?.id) ?? die(`boat new didn't say the sandbox is ready:\n${made}`);
    }
    for (let waited = 0; ['stopping', 'pending'].includes(box.state) && waited < 600; waited += 5) {
        sleep(5);
        box = sandboxes().find((row) => row.id === box?.id) ?? box;
    }
    if (box.state === 'stopped') {
        say(`Resuming ${BOAT_NAME}`);
        if (run('boat', ['resume', box.id], { stdio: ['ignore', 'ignore', 'inherit'] }) !== 0) die(`Couldn't resume ${box.id}`);
    } else if (box.state === 'error') die(`${BOAT_NAME} (${box.id}) is broken: boat recover ${box.id}, or boat delete ${box.id} --yes`);
    return box;
}

/**
 * Runs a shell command in a sandbox with its output as it comes: `boat exec --json --stream` frames (boat prints JSON whenever its output
 * isn't a terminal), each part written where the command wrote it. The command's status.
 */
function boatExec(id: string, command: string, quiet: boolean): Promise<number> {
    return new Promise((done) => {
        const child = spawn('boat', ['exec', id, '--timeout', '0', '--json', '--stream', command], {
            stdio: ['ignore', 'pipe', 'inherit'],
        });
        let status: number | undefined;
        createInterface({ input: child.stdout }).on('line', (line) => {
            let frame: { type?: string; data?: string; exitCode?: number | null };
            try {
                frame = JSON.parse(line) as typeof frame;
            } catch {
                if (!quiet) console.log(line);
                return;
            }
            if (frame.type === 'stdout' && !quiet) process.stdout.write(frame.data ?? '');
            else if (frame.type === 'stderr') process.stderr.write(frame.data ?? '');
            else if (frame.type === 'exit') status = frame.exitCode ?? 128;
        });
        child.on('error', (error) => die(`Couldn't run boat: ${error.message}`));
        child.on('close', (code) => done(status ?? code ?? 1));
    });
}

function boatMachine(): Machine {
    const box = sandbox();
    const dir = '/home/user/cue';
    // setup-linux.sh puts Node.js 26 and pnpm in /opt/node, in front of the Node.js the image has.
    const shell = (body: string, admin = false): string => {
        const script = `export PATH=/opt/node/bin:$PATH; cd ${shellQuote(dir)} 2>/dev/null; ${body}`;
        return `${admin ? 'sudo ' : ''}bash -c ${shellQuote(script)}`;
    };
    const script = (body: string, { admin = false, quiet = false } = {}): Promise<number> => boatExec(box.id, shell(body, admin), quiet);
    return {
        target: 'boat',
        base: '/home/user',
        dir,
        windows: false,
        script,
        output: (body) => {
            const ran = capture('boat', ['exec', box.id, '--timeout', '600', '--json', shell(body)], true);
            try {
                const result = JSON.parse(ran.stdout) as { exitCode?: number; stdout?: string };
                return result.exitCode === 0 ? (result.stdout ?? '') : undefined;
            } catch {
                return undefined;
            }
        },
        sync: async () => {
            const incoming = `${dir}.incoming`;
            checkoutFiles();
            if ((await script(`rm -rf ${shellQuote(incoming)}`, { quiet: true })) !== 0) die(`Couldn't reach ${box.id}`);
            // In a git checkout boat push copies what git tracks or doesn't ignore, as tarball() does for the VMs.
            if (run('boat', ['push', box.id, ROOT, '--to', incoming], { stdio: ['ignore', 'ignore', 'inherit'] }) !== 0)
                die(`Couldn't copy the checkout into ${box.id}`);
            // rsync is in the image (setup-linux.sh adds it where it isn't).
            const mirrored = await script(
                `command -v rsync >/dev/null || sudo apt-get install -y -qq rsync >/dev/null; ${mirror(incoming, dir)}`,
            );
            if (mirrored !== 0) die(`Couldn't bring ${dir} in ${box.id} up to date`);
        },
        fetch: (from, to) => run('boat', ['scp', `${box.id}:${from}`, to], { stdio: ['ignore', 'ignore', 'inherit'] }) === 0,
    };
}

/** The checkout's files: what git tracks and the untracked files it doesn't ignore, as they are now. */
function checkoutFiles(): string[] {
    const listed = capture('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard']).stdout.split('\0');
    // Deleted but not yet staged, and submodules' folders, aren't files to copy.
    const files = [...new Set(listed)].filter((file) => file !== '' && existsSync(join(ROOT, file)) && statSync(join(ROOT, file)).isFile());
    for (const file of files) sent.set(file, digest(join(ROOT, file)));
    return files;
}

/** The checkout as a tarball. */
function tarball(): string {
    mkdirSync(local, { recursive: true });
    const files = checkoutFiles();
    const list = join(local, 'files'),
        tar = join(local, 'checkout.tar');
    writeFileSync(list, `${files.join('\0')}\0`);
    rmSync(tar, { force: true });
    // No AppleDouble files or extended attributes: the VMs' tar would unpack them as files.
    const made = run('tar', ['--no-mac-metadata', '--no-xattrs', '-cf', tar, '--null', '-T', list], {
        cwd: ROOT,
        env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    if (made !== 0) die("Couldn't pack the checkout");
    return tar;
}

/** Marker files say what was done last (a hash of what it was done from), to do it again only when that changes. */
function readMarker(machine: Machine, path: string): string {
    return (
        machine.output(
            machine.windows
                ? `if (Test-Path -LiteralPath ${quotePs(path)}) { Get-Content -Raw -LiteralPath ${quotePs(path)} }`
                : `cat ${shellQuote(path)} 2>/dev/null || true`,
        ) ?? ''
    ).trim();
}

async function writeMarker(machine: Machine, path: string, value: string): Promise<void> {
    await machine.script(
        machine.windows
            ? `Set-Content -NoNewline -LiteralPath ${quotePs(path)} -Value ${quotePs(value)}`
            : `printf %s ${shellQuote(value)} > ${shellQuote(path)}`,
        { quiet: true },
    );
}

/**
 * The scripts that install a machine's toolchain: the first as administrator, then in a VM Cua Driver's, as the VM's user (elevated on
 * Windows, where registering its daemon's Scheduled Task needs it).
 */
const SETUP = {
    mac: ['apps/mac/scripts/setup.sh', 'tests/e2e/tools/cua-driver.sh'],
    windows: ['apps/windows/scripts/setup.ps1', 'tests/e2e/tools/cua-driver.ps1'],
    boat: ['tests/e2e/tools/setup-linux.sh'],
} as const;

/** One toolchain per machine, shared by its checkouts' copies: what it was installed from. */
const toolchainMarker = (machine: Machine): string => `${machine.base}${machine.windows ? '\\' : '/'}toolchain.txt`;
const toolchainOf = (machine: Machine): string => fileHash(...SETUP[machine.target]);

/** Runs a script of the checkout's copy: PowerShell's, or the interpreter its first line names. Its status. */
function runScript(machine: Machine, file: string, admin: boolean): Promise<number> {
    if (machine.windows)
        return machine.script(`& ${quotePs(`${machine.dir}\\${file.replaceAll('/', '\\')}`)}; exit $LASTEXITCODE`, { admin });
    const interpreter = readFileSync(join(ROOT, file), 'utf8').split('\n')[0]?.replace(/^#!/, '').trim() || '/bin/sh';
    return machine.script(`exec ${interpreter} ${shellQuote(`${machine.dir}/${file}`)}`, { admin });
}

async function installToolchain(machine: Machine): Promise<void> {
    if (machine.target === 'mac') copyXcode(machine);
    const [setup, driver] = SETUP[machine.target];
    say(`Installing the toolchain (${setup})`);
    if ((await runScript(machine, setup, true)) !== 0) die(`${setup} failed`);
    if (driver !== undefined) {
        say(`Installing Cua Driver (${driver})`);
        if ((await runScript(machine, driver, machine.windows)) !== 0) die(`${driver} failed`);
    }
    const toolchain = toolchainOf(machine);
    await writeMarker(machine, toolchainMarker(machine), toolchain);
    if (machine.target !== 'boat') snapshot(machine.target, toolchain);
}

/** The toolchain (once, and again when one of its scripts changes), then the packages (when the lockfile or the Worker's bindings change). */
async function prepare(machine: Machine): Promise<void> {
    if (readMarker(machine, toolchainMarker(machine)) !== toolchainOf(machine)) await installToolchain(machine);
    // Again when it couldn't be taken then (VMPal takes none of a running VM while this Mac is locked).
    else if (machine.target !== 'boat') snapshot(machine.target, toolchainOf(machine));
    const packages = hash(toolchainOf(machine), fileHash('pnpm-lock.yaml', 'apps/api/cloudflare.config.ts'));
    const packagesMarker = `${machine.dir}.packages`;
    if (readMarker(machine, packagesMarker) !== packages) {
        say('Installing the packages');
        // As setup.ps1 -Install (CI's Windows jobs) does: pnpm 12 adds the lockfile's packageManagerDependencies whenever it resolves, which
        // --frozen-lockfile refuses.
        // The copy's lockfile is the checkout's again at the next command, and nothing brings it back here.
        const installed = await machine.script(
            machine.windows
                ? `& pnpm install; if ($LASTEXITCODE -ne 0) { exit 1 }; & pnpm --filter api types; exit $LASTEXITCODE`
                : 'pnpm install && pnpm --filter api types',
        );
        if (installed !== 0) die('pnpm install failed');
        await writeMarker(machine, packagesMarker, packages);
    }
}

/**
 * Cua Driver's command line in the VM (tests/e2e/tools/cua-driver.sh and .ps1 install it): its status. A screenshot it writes
 * (`--screenshot-out-file PATH`) is written there and brought to PATH here.
 */
async function cua(machine: Machine, args: readonly string[]): Promise<number> {
    const there = `${machine.dir}.cua.png`;
    let shot: string | undefined;
    const words: string[] = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index] ?? '';
        if (arg === '--screenshot-out-file' && index + 1 < args.length) {
            shot = args[++index];
            words.push(arg, there);
        } else if (arg.startsWith('--screenshot-out-file=')) {
            shot = arg.slice(arg.indexOf('=') + 1);
            words.push(`--screenshot-out-file=${there}`);
        } else words.push(arg);
    }
    if (machine.target === 'mac' && words[0] === 'permissions' && words[1] === 'grant') {
        // Someone at the VM allows it: macOS lets nothing else switch an app on in Privacy & Security.
        const vm = vms().find((row) => row.name === VMS.mac.name);
        if (vm !== undefined) vmpal(['show', vm.id], true);
        say(
            `In ${VMS.mac.name}'s window: Open System Settings, then switch CuaDriver on under Accessibility and under Screen & System Audio Recording`,
        );
    }
    let status: number;
    if (machine.windows) {
        // Windows PowerShell drops the double quotes of an argument it passes to a program: the JSON of `call` goes through stdin, in UTF-8.
        const json = words.findIndex((word, index) => index > 0 && words[0] === 'call' && word.startsWith('{'));
        const rest = words.filter((_, index) => index !== json);
        const input = json === -1 ? '' : `${quotePs(words[json] ?? '')} | `;
        status = await machine.script(
            `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ${input}& (Join-Path $env:LOCALAPPDATA 'Programs\\Cua\\cua-driver\\bin\\cua-driver.exe') ${rest.map(quotePs).join(' ')}; exit $LASTEXITCODE`,
        );
    } else status = await machine.script(`exec "$HOME/.local/bin/cua-driver" ${words.map((word) => shellQuote(word)).join(' ')}`);
    if (status === 0 && shot !== undefined) {
        if (!machine.fetch(there, resolve(shot))) die(`Couldn't bring the screenshot back from ${there}`);
        console.log(`Screenshot: ${resolve(shot)}`);
    }
    return status;
}

/** A snapshot of the VM with its toolchain, to go back to: one for each toolchain, named after it. */
function snapshot(target: 'mac' | 'windows', toolchain: string): void {
    const vm = vms().find((row) => row.name === VMS[target].name);
    if (vm === undefined) return;
    const name = `${SNAPSHOT}-${toolchain.slice(0, 8)}`;
    const snapshots = (JSON.parse(vmpalOut(['snapshots', vm.id, '--json']).stdout) as { snapshots?: { name: string }[] }).snapshots ?? [];
    if (snapshots.some((snapshot) => snapshot.name === name)) return;
    say(`Snapshotting ${vm.name} as ${name}`);
    vmpal(['snapshot', vm.id, name], true);
}

/**
 * Xcode for the Mac VM, from this Mac: Apple's downloads of it need someone's Apple Account, and its Command Line Tools can't build Cue
 * (SwiftUI's macros are Xcode's plugins). setup.sh selects it and accepts its license.
 */
function copyXcode(machine: Machine): void {
    if (machine.output('test -d /Applications/Xcode.app') !== undefined) return;
    if (!existsSync('/Applications/Xcode.app'))
        die('The Mac VM needs Xcode, which is copied from /Applications/Xcode.app here: install Xcode');
    say('Copying Xcode into the VM (once)');
    const vm = vms().find((row) => row.name === VMS.mac.name) ?? die(`No ${VMS.mac.name}`);
    if (vmpal(['cp', '--admin', '--timeout', '2h', '/Applications/Xcode.app', `${vm.id}:/Applications/`]) !== 0)
        die("Couldn't copy Xcode into the VM");
}

/** The cases' logs (E2E_WORK/*.log) of the run just over, into this checkout's folder in $TMPDIR. */
async function fetchLogs(machine: Machine, work: string): Promise<void> {
    const tar = `${machine.dir}.logs.tar`;
    const packed = await machine.script(
        machine.windows
            ? `$f = @(Get-ChildItem -LiteralPath ${quotePs(work)} -Filter *.log -ErrorAction SilentlyContinue | ForEach-Object Name); if ($f.Count -eq 0) { exit 1 }; & tar.exe -cf ${quotePs(tar)} -C ${quotePs(work)} @f; exit $LASTEXITCODE`
            : `cd ${shellQuote(work)} && set -- *.log && [ -e "$1" ] && tar -cf ${shellQuote(tar)} "$@"`,
        { quiet: true },
    );
    if (packed !== 0) return;
    const logs = join(local, `${machine.target}-logs`);
    rmSync(logs, { recursive: true, force: true });
    mkdirSync(logs, { recursive: true });
    if (machine.fetch(tar, join(local, 'logs.tar')) && run('tar', ['-xf', join(local, 'logs.tar'), '-C', logs]) === 0)
        console.log(`Case logs: ${logs} (and in ${work} there)`);
}

/** What a command changed in the copy's files (`vp check --fix`), brought back into this checkout: the files it changed, by name. */
async function bringBack(machine: Machine): Promise<string[]> {
    const tar = `${machine.dir}.back.tar`;
    const excluded = KEPT.map((name) => `--exclude=${name}`).join(' ');
    const packed = await machine.script(
        machine.windows
            ? `& tar.exe -cf ${quotePs(tar)} ${excluded} -C ${quotePs(machine.dir)} .; exit $LASTEXITCODE`
            : `tar -cf ${shellQuote(tar)} ${excluded} -C ${shellQuote(machine.dir)} .`,
        { quiet: true },
    );
    const back = join(local, 'back');
    rmSync(back, { recursive: true, force: true });
    mkdirSync(back, { recursive: true });
    if (packed !== 0 || !machine.fetch(tar, join(local, 'back.tar')) || run('tar', ['-xf', join(local, 'back.tar'), '-C', back]) !== 0)
        die(`Couldn't bring the changed files back from ${machine.dir}`);
    // Only the TypeScript and JavaScript the check fixes (pnpm install rewrites pnpm-lock.yaml there), and only where the file here is still
    // what was sent: an edit made meanwhile wins.
    const changed = [...sent].filter(
        ([file, before]) => /\.[cm]?[jt]sx?$/.test(file) && existsSync(join(back, file)) && digest(join(back, file)) !== before,
    );
    for (const [file, before] of changed) {
        if (existsSync(join(ROOT, file)) && digest(join(ROOT, file)) === before)
            writeFileSync(join(ROOT, file), readFileSync(join(back, file)));
        else console.log(`${file} changed here meanwhile: its fix is in ${join(back, file)}`);
    }
    return changed.map(([file]) => file);
}

function status(): void {
    const rows = vmpalCommand.length === 0 ? [] : vms();
    for (const target of ['mac', 'windows'] as const) {
        const vm = rows.find((row) => row.name === VMS[target].name);
        console.log(`${target.padEnd(8)} ${VMS[target].name}: ${vm === undefined ? 'not made yet' : `${vm.state} (${vm.id})`}`);
    }
    const box = onPath('boat') ? sandboxes().find((row) => row.name === BOAT_NAME) : undefined;
    console.log(`boat     ${BOAT_NAME}: ${box === undefined ? 'not made yet' : `${box.state} (${box.id})`}`);
    console.log(`This checkout's copy: C:\\cue\\${checkout} on Windows, ~/cue/${checkout} on the Mac, /home/user/cue on Boat`);
}

const [target, ...rest] = process.argv.slice(2);
if (target === undefined || target === '-h' || target === '--help') {
    console.log(usage());
    process.exit(target === undefined ? 2 : 0);
}
if (target === 'status') {
    status();
    process.exit(0);
}
if (target !== 'mac' && target !== 'windows' && target !== 'boat') {
    console.log(`No such machine: ${target} (mac, windows or boat)`);
    process.exit(2);
}
const admin = rest[0] === '--admin';
let command = admin ? rest.slice(1) : rest;

if (command[0] === 'stop' && command.length === 1) {
    if (target === 'boat') {
        const box = onPath('boat') ? sandboxes().find((row) => row.name === BOAT_NAME) : undefined;
        process.exit(box === undefined ? 0 : run('boat', ['stop', box.id], { stdio: ['ignore', 'ignore', 'inherit'] }));
    }
    const vm = vms().find((row) => row.name === VMS[target].name);
    process.exit(vm === undefined || vm.state !== 'running' ? 0 : vmpal(['suspend', vm.id], true));
}
const e2e = command[0] === 'e2e';
if (e2e && target === 'boat') {
    console.log('Cases run in the VMs: node tests/e2e/remote.ts mac e2e --no-app … for the backend’s own');
    process.exit(2);
}
if (command[0] === 'cua') {
    if (target === 'boat') {
        console.log('Cua Driver drives the VMs: node tests/e2e/remote.ts mac|windows cua …');
        process.exit(2);
    }
    // The copy is only what installs Cua Driver: it is brought up to date when the driver isn't installed yet.
    const machine = vmMachine(target);
    if (readMarker(machine, toolchainMarker(machine)) !== toolchainOf(machine)) {
        say(`Copying this checkout to ${machine.dir}`);
        await machine.sync();
        await installToolchain(machine);
    }
    process.exit(await cua(machine, command.slice(1)));
}

const machine = target === 'boat' ? boatMachine() : vmMachine(target);
say(`Copying this checkout to ${machine.dir}`);
await machine.sync();
await prepare(machine);

const fix = command[0] === 'check' && command[1] === '--fix' && command.length === 2;
if (e2e) command = ['node', 'tests/e2e/run.ts', ...command.slice(1)];
else if (command[0] === 'check' && (command.length === 1 || fix)) command = ['pnpm', 'vp', ...command];
if (command.length === 0) {
    console.log(`Ready: ${machine.dir}`);
    process.exit(0);
}
const work = `${machine.dir}.e2e`;
const env = machine.windows ? `$env:E2E_WORK = ${quotePs(work)}; ` : `export E2E_WORK=${shellQuote(work)}; `;
const exitStatus = await machine.script(`${env}${commandLine(machine.windows, command)}`, { admin });
if (e2e) await fetchLogs(machine, work);
if (fix) {
    const changed = await bringBack(machine);
    console.log(changed.length === 0 ? 'Nothing to fix here' : `Fixed here: ${changed.join(' ')}`);
}
process.exit(exitStatus);
