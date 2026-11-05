import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertDeepEq, assertEq, assertTextContains, e2eCase, exec, fail, lines, literal, print, windowText } from '../harness/index.ts';

/** The switches of Settings › General that are the account's, as Settings names them. */
const SWITCHES = {
    autoAnswer: 'Answer questions automatically',
    micQuestions: 'Also listen for questions from people in the room',
    summarize: 'Write a summary of each call',
    keepAudio: 'Keep audio',
};

/** Whether each switch is on, as UI Automation's toggle pattern says (what a screen reader reads): by the account's names for them. */
async function switches(pid: number): Promise<Partial<Record<string, boolean>>> {
    const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;
    const script = [
        'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
        '$auto = [System.Windows.Automation.AutomationElement]',
        `$mine = New-Object System.Windows.Automation.PropertyCondition($auto::ProcessIdProperty, ${pid})`,
        `foreach ($name in @(${Object.values(SWITCHES).map(quoted).join(', ')})) {`,
        '  $named = New-Object System.Windows.Automation.PropertyCondition($auto::NameProperty, $name)',
        "  $state = 'missing'",
        '  foreach ($window in $auto::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $mine)) {',
        '    foreach ($element in $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $named)) {',
        '      $pattern = $null',
        '      if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) { $state = [string]$pattern.Current.ToggleState }',
        '    }',
        '  }',
        '  "$name=$state"',
        '}',
    ].join('\n');
    const ran = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const states = new Map(
        ran.stdout
            .split(/\r?\n/)
            .filter((line) => line.includes('='))
            .map((line) => [line.slice(0, line.lastIndexOf('=')), line.slice(line.lastIndexOf('=') + 1)] as const),
    );
    const read: Record<string, boolean> = {};
    for (const [key, name] of Object.entries(SWITCHES)) {
        const state = states.get(name);
        if (state !== 'On' && state !== 'Off') fail(`the switch "${name}" isn't on the page (${state ?? 'not read'})`, ran.output);
        read[key] = state === 'On';
    }
    return read;
}

e2eCase(
    'Cue for Windows: the name, Auto, questions from the room, summaries and keeping audio are the account’s — this PC’s go to it at the first sign-in, ' +
        'another device’s change reaches the app and Settings › General while it is open, a change here is saved to the account (and put back when it ' +
        'isn’t taken), and the next launch follows the account.',
    async (cue) => {
        await cue.defaults('speakerName', 'PC Name');
        await cue.defaults('autoAnswer', false);
        await cue.defaults('micQuestions', true);
        await cue.defaults('summarizeRecordings', false);
        await cue.defaults('keepAudio', false);
        const backend = await cue.backend();
        await cue.launch({ CUE_ME_TICK: '2' });
        const token = (await backend.tokensFor(cue.email)).access_token;
        const account = async () =>
            (await backend.call('GET', '/v1/me', token)).body.settings as Record<string, string | boolean | undefined>;
        const local = () =>
            JSON.parse(readFileSync(join(cue.support, 'settings.json'), 'utf8')) as Record<string, string | boolean | undefined>;
        const said = (settings: string) => new RegExp(`⚙️ Settings: ${literal(settings)}$`);

        // The first sign-in: the account had none, so it gets this PC's, before anything else is loaded.
        await cue.waitLog(/📦 Imported your settings from this PC$/, 30);
        await cue.waitLog(said('name “PC Name”, Auto off, questions from the room on, summaries off, audio not kept'), 30);
        const log = lines(cue.sessionLog());
        const at = (pattern: RegExp) => log.findIndex((line) => pattern.test(line));
        if (!(at(/📦 Imported your settings/) < at(/⚙️ Settings: /) && at(/⚙️ Settings: /) < at(/🔑 Signed in to Cue as /)))
            fail('the settings should be imported, then said, before Cue counts as signed in', log.join('\n'));
        assertDeepEq(await account(), {
            speakerName: 'PC Name',
            autoAnswer: false,
            micQuestions: true,
            summarize: false,
            keepAudio: false,
        });

        // Settings › General shows them (the window as tall as the screen allows: UI Automation sees only what is scrolled into view).
        cue.control('size 1100 1400');
        cue.control('settings general');
        let text = '';
        const shows = async (what: string, check: (text: string) => boolean) => {
            await cue
                .waitFor(what, 30, async () => check((text = await windowText(cue.pid))))
                .catch((error: unknown) => {
                    print('--- the window shows', text);
                    throw error;
                });
        };
        await shows('Settings › General with the name', (text) => /^Your name\nPC Name$/m.test(text));
        assertTextContains(
            text,
            /^Your name, Auto, questions from the room and what notes keep are kept in your Cue account: the same on every Mac and PC you sign in to\.$/,
        );
        assertTextContains(text, /^Answers$/, 'the Answers group');
        assertDeepEq(await switches(cue.pid), { autoAnswer: false, micQuestions: true, summarize: false, keepAudio: false });

        // Another device changes two: the app follows on its next look at the account, and so does the page, open all along.
        const changed = await backend.call('PATCH', '/v1/me/settings', token, { body: { speakerName: 'Ann Other', autoAnswer: true } });
        assertEq(changed.status, 200);
        await cue.waitLog(said('name “Ann Other”, Auto on, questions from the room on, summaries off, audio not kept'), 30);
        assertEq(local()['speakerName'], 'Ann Other', 'settings.json has the name');
        assertEq(local()['autoAnswer'], true, 'and Auto');
        await shows('the new name on the page', (text) => /^Your name\nAnn Other$/m.test(text));
        assertDeepEq(await switches(cue.pid), { autoAnswer: true, micQuestions: true, summarize: false, keepAudio: false }, 'Auto is on');
        assertEq(cue.logCount(/☁️ Saved your settings/), 0, 'what came from the account is not saved back');

        // A change here: saved to the account, and the page shows it.
        cue.control('setting keepAudio | on');
        await cue.waitLog(/☁️ Saved your settings to your account$/, 30);
        await cue.waitLog(said('name “Ann Other”, Auto on, questions from the room on, summaries off, audio kept'), 30);
        assertEq((await account())['keepAudio'], true, 'the account keeps the audio now');
        assertEq(local()['keepAudio'], true);
        await cue.waitFor('the switch to follow', 20, async () => (await switches(cue.pid)).keepAudio === true);

        // One the account doesn't take (a name too long for it): said so, and the account's value is back.
        cue.control('page home');
        cue.control(`setting speakerName | ${'A'.repeat(201)}`);
        await cue.waitLog(/⚠︎ Couldn't save your settings: /, 30);
        await cue.waitFor('the name to be the account’s again', 10, () => local()['speakerName'] === 'Ann Other');
        assertEq((await account())['speakerName'], 'Ann Other');

        // The next launch: nothing to import, and the account's values win over what this PC's file says.
        await cue.stop();
        await cue.defaults('speakerName', 'Stale Name');
        await cue.defaults('autoAnswer', false);
        // (The account is read at sign-in only now, so what follows comes from the saves' answers alone.)
        await cue.launch({ CUE_ME_TICK: '600' });
        await cue.waitLog(said('name “Ann Other”, Auto on, questions from the room on, summaries off, audio kept'), 30);
        assertEq(cue.logCount(/📦 Imported your settings/), 0, 'imported once, at the first sign-in');
        assertEq(local()['speakerName'], 'Ann Other');
        assertEq(local()['autoAnswer'], true);
        assertDeepEq(await account(), {
            speakerName: 'Ann Other',
            autoAnswer: true,
            micQuestions: true,
            summarize: false,
            keepAudio: true,
        });

        // A name saved, then one the account refuses before it is read again: the saved one is back, not the one the sign-in read.
        cue.control('setting speakerName | PC Again');
        await cue.waitLog(said('name “PC Again”, Auto on, questions from the room on, summaries off, audio kept'), 30);
        cue.control(`setting speakerName | ${'B'.repeat(201)}`);
        await cue.waitFor('the refusal', 30, () => cue.logCount(/⚠︎ Couldn't save your settings: /) === 1);
        await cue.waitFor('the saved name to be back', 10, () => local()['speakerName'] === 'PC Again');
        assertEq((await account())['speakerName'], 'PC Again');
    },
);
