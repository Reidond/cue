// Running other programs: the app's command-line modes, the Swift tools, macOS commands.
import { spawn } from 'node:child_process';
import { constants } from 'node:os';

export interface Ran {
    /** The exit status; 128 + the signal's number when a signal ended it, 127 when it couldn't start. */
    code: number;
    stdout: string;
    stderr: string;
    /** stdout and stderr together, in the order they came, as `2>&1` would have them. */
    output: string;
}

export interface RunOptions {
    env?: NodeJS.ProcessEnv;
    /** The folder it runs in; the current one by default. */
    cwd?: string;
    /** Written to its stdin, which is then closed; without it, stdin is empty. */
    input?: string;
    /** Seconds after which it is killed (its code is then 137). */
    timeout?: number;
}

/** Runs a program to the end and collects what it printed. Never throws: check `code`. */
export function exec(command: string, args: readonly string[] = [], options: RunOptions = {}): Promise<Ran> {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            env: options.env ?? process.env,
            cwd: options.cwd,
            stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
        let stdout = '',
            stderr = '',
            output = '';
        const timer = options.timeout === undefined ? undefined : setTimeout(() => child.kill('SIGKILL'), options.timeout * 1000);
        child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
            stdout += chunk;
            output += chunk;
        });
        child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
            stderr += chunk;
            output += chunk;
        });
        child.on('error', (error) => resolve({ code: 127, stdout, stderr: error.message, output: error.message }));
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            resolve({ code: code ?? 128 + (signal ? constants.signals[signal] : 0), stdout, stderr, output });
        });
        if (options.input !== undefined) child.stdin?.end(options.input);
    });
}

/** Quotes a word for a shell script the harness writes. */
export function shellQuote(word: string): string {
    return `'${word.replaceAll("'", `'\\''`)}'`;
}
