import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertEq, assertTextNotContains, e2eCase, exec, fail, print, windowText } from '../harness/index.ts';

/** Lines of a window's text, one after another (UI Automation reads a window's elements in order; a combo box is its name, then its choice). */
const together = (...lines: string[]) =>
    new RegExp(`^${lines.map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\n')}$`, 'm');

/**
 * Picks an option of a drop-down by their names through UI Automation, as Narrator does: the combo box expands, the option is selected, it collapses.
 * Nothing is clicked and no window comes to the front.
 */
async function choose(pid: number, picker: string, option: string): Promise<void> {
    const quoted = (text: string) => `'${text.replaceAll("'", "''")}'`;
    const script = [
        'Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes',
        '$auto = [System.Windows.Automation.AutomationElement]',
        '$all = [System.Windows.Automation.TreeScope]::Descendants',
        `$mine = New-Object System.Windows.Automation.PropertyCondition($auto::ProcessIdProperty, ${pid})`,
        'function Find($name, $test) {',
        '  $named = New-Object System.Windows.Automation.PropertyCondition($auto::NameProperty, $name)',
        '  foreach ($window in $auto::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $mine)) {',
        '    foreach ($element in $window.FindAll($all, $named)) { if (& $test $element) { return $element } }',
        '  }',
        '  return $null',
        '}',
        `$box = Find ${quoted(picker)} { param($e) $e.Current.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox }`,
        "if (-not $box) { 'missing'; exit 0 }",
        '$expand = $box.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)',
        '$expand.Expand()',
        '$item = $null',
        'for ($i = 0; $i -lt 20 -and -not $item; $i++) {',
        '  Start-Sleep -Milliseconds 200',
        `  $item = Find ${quoted(option)} { param($e) $p = $null; $e.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p) }`,
        '}',
        'if ($item) { $item.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select() }',
        'try { $expand.Collapse() } catch { }',
        "if ($item) { 'ok' } else { 'no option' }",
    ].join('\n');
    const ran = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (ran.stdout.trim() !== 'ok') fail(`couldn't choose "${option}" in "${picker}" (${ran.stdout.trim()})`, ran.output);
}

e2eCase(
    'Cue for Windows: Settings › General › Languages picks the languages Cue is read in — the second once there is a first, and with two how answers ' +
        'and notes lay them out — and saves them to the account; the account changed elsewhere shows there too, and `languages` sets them.',
    async (cue) => {
        const backend = await cue.backend();
        await cue.launch({ CUE_ME_TICK: '2' });
        const token = (await backend.tokensFor(cue.email)).access_token;
        const accountLanguages = async () =>
            ((await backend.call('GET', '/v1/me', token)).body as { languages: string[] }).languages.join(',');
        const settings = () => readFileSync(join(cue.support, 'settings.json'), 'utf8');

        let text = '';
        const shows = async (what: string, pattern: RegExp) => {
            await cue
                .waitFor(what, 30, async () => {
                    text = await windowText(cue.pid);
                    return pattern.test(text);
                })
                .catch((error: unknown) => {
                    print('--- the window shows', text);
                    throw error;
                });
            return text;
        };

        // None yet: the first picker alone.
        cue.control('settings general');
        await shows('the Languages group', together('Read Cue in', 'None'));
        cue.save('settings-none.txt', text);
        assertTextNotContains(text, /^Second language$/, 'no second before a first');
        assertTextNotContains(text, /^How the overlay shows an answer in both$/, 'no layouts with one or none');

        // A first: saved to the account; the second is offered, without the first among its options.
        await choose(cue.pid, 'Read Cue in', 'English');
        await cue.waitLog(/🌐 Languages: English$/, 30);
        assertEq(await accountLanguages(), 'en', 'the account has it');
        await shows('the second picker', together('Second language', 'None'));
        assertTextNotContains(text, /^How the overlay shows an answer in both$/, 'no layouts with one');

        // A second: both in the account; the layouts appear, at their defaults.
        await choose(cue.pid, 'Second language', 'Українська');
        await cue.waitLog(/🌐 Languages: English, Ukrainian$/, 30);
        assertEq(await accountLanguages(), 'en,uk');
        await shows('the layouts', together('Answers', 'Subtitles'));
        cue.save('settings-two.txt', text);
        assertEq(together('Read Cue in', 'English').test(text), true, 'the first shows');
        assertEq(together('Second language', 'Українська').test(text), true, 'the second shows');
        assertEq(together('Notes', 'Switch between them').test(text), true, 'the notes’ layout');

        // The layouts are this PC's.
        await choose(cue.pid, 'Answers', 'Focus');
        await cue.waitFor('the answers’ layout to be kept', 10, () => /"answerLayout": "focus"/.test(settings()));
        await choose(cue.pid, 'Notes', 'One after another');
        await cue.waitFor('the notes’ layout to be kept', 10, () => /"noteLayout": "both"/.test(settings()));
        await shows('the layouts chosen', together('Answers', 'Focus'));
        assertEq(together('Notes', 'One after another').test(text), true);
        assertEq(await accountLanguages(), 'en,uk', 'the layouts are not the account’s');

        // Changed in the account (another PC): Cue sees it on its next look.
        await backend.call('PUT', '/v1/me/languages', token, { body: { languages: [] } });
        await cue.waitLog(/🌐 Languages: none — Cue follows the language it hears$/, 30);
        await shows('none again', together('Read Cue in', 'None'));
        assertTextNotContains(text, /^Second language$/);

        // The command sets them, in order; one the account doesn't take is said so, and nothing changes.
        cue.control('languages uk en');
        await cue.waitLog(/🌐 Languages: Ukrainian, English$/, 30);
        assertEq(await accountLanguages(), 'uk,en');
        await shows('both, Ukrainian first', together('Read Cue in', 'Українська'));
        assertEq(together('Second language', 'English').test(text), true);
        cue.control('languages en xx');
        await cue.waitLog(/⚠︎ Couldn't save your languages: /, 30);
        assertEq(await accountLanguages(), 'uk,en', 'as it was');
    },
);
