import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    accountProject,
    assertEq,
    assertTextContains,
    assertTextNotContains,
    bursts,
    e2eCase,
    exec,
    fail,
    fixture,
    print,
    windowsOf,
    windowText,
} from '../harness/index.ts';

/** What Claude answers (in English; with two languages the stand-in follows each line with its translation, from TRANSLATIONS). */
const ANSWER = [
    'We studied 48 hives on 6 rooftops in Kyiv.',
    '• Two seasons, spring to autumn',
    '• Winter losses were 9 percent, below the national average',
    'Numbers: 48 hives, 6 rooftops, 9 percent',
    'Source: talk.md',
].join('\n');

const TRANSLATIONS = {
    'How many hives did you study?': 'Скільки вуликів ви дослідили?',
    'We studied 48 hives on 6 rooftops in Kyiv.': 'Ми дослідили 48 вуликів на 6 дахах у Києві.',
    '• Two seasons, spring to autumn': '• Два сезони, з весни до осені',
    '• Winter losses were 9 percent, below the national average':
        '• Зимові втрати становили 9 відсотків, менше за середній показник по країні',
    'Numbers: 48 hives, 6 rooftops, 9 percent': 'Цифри: 48 вуликів, 6 дахів, 9 відсотків',
    'Source: talk.md': 'Джерело: talk.md',
};

/** Lines of a window's text, one after another (UI Automation reads a window's elements in order). */
const together = (...lines: string[]) =>
    new RegExp(`^${lines.map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\n')}$`, 'm');

/** The overlay's left edge dragged until it is `width` effective pixels wide (SetWindowPos from outside, as a person's drag ends; it never takes the focus). */
async function overlayWidth(pid: number, width: number): Promise<void> {
    const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Overlay {
    private delegate bool Visit(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] private static extern bool EnumWindows(Visit visit, IntPtr data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [StructLayout(LayoutKind.Sequential)] private struct Rect { public int Left, Top, Right, Bottom; }
    public static string Resize(uint pid, int width) {
        SetProcessDPIAware();
        IntPtr found = IntPtr.Zero;
        EnumWindows((window, data) => {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            var title = new StringBuilder(64);
            GetWindowText(window, title, 64);
            if (owner == pid && title.ToString() == "Cue overlay") { found = window; return false; }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) return "missing";
        Rect rect;
        GetWindowRect(found, out rect);
        int pixels = (int)Math.Round(width * GetDpiForWindow(found) / 96.0);
        // Its left edge dragged: the right one stays (the overlay sits in the screen's top right corner). SWP_NOZORDER | SWP_NOACTIVATE.
        SetWindowPos(found, IntPtr.Zero, rect.Right - pixels, rect.Top, pixels, rect.Bottom - rect.Top, 0x0004 | 0x0010);
        return "ok";
    }
}
'@
[Overlay]::Resize(${pid}, ${width})`;
    const ran = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    if (ran.stdout.trim() !== 'ok') fail('the overlay could not be resized', ran.output);
}

e2eCase(
    'Cue for Windows: with two languages chosen, a question and its answer show in both on the overlay — as Subtitles, Side by side (Subtitles while the ' +
        'overlay is too narrow) and Focus — and with one language again the next answer is in that one alone.',
    async (cue) => {
        const project = await accountProject(cue, 'Bees', { materials: [fixture('materials', 'talk.md')] });
        const backend = await cue.backend();
        const put = await backend.call('PUT', '/v1/me/languages', project.token, { body: { languages: ['en', 'uk'] } });
        assertEq(put.status, 200, 'the account takes two languages');
        const call = await bursts(cue.path('call.wav'), 5, [[1, 3.5]]);
        await cue.launch({
            CUE_PROJECT: 'Bees',
            CUE_REHEARSE_PARTICIPANT: call,
            FAKE_DEEPGRAM_LIVE: JSON.stringify(['Thank you for the talk. How many hives did you study?']),
            FAKE_CLAUDE_ANSWER: ANSWER,
            FAKE_CLAUDE_TRANSLATIONS: JSON.stringify(TRANSLATIONS),
        });
        await cue.waitLog(/🌐 Languages: English, Ukrainian$/, 30);
        await cue.waitLog(/❓ \*\*Question:\*\* How many hives did you study\?/, 120);
        await cue.waitLog(/Answer\*\* \(/, 60);
        assertEq(
            readFileSync(cue.sessionLog(), 'utf8').includes('» Ми дослідили 48 вуликів на 6 дахах у Києві.'),
            true,
            'the answer came with its translation',
        );

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

        // Subtitles (the default): each line, and right under it its translation; the question too.
        await shows(
            'the answer as subtitles',
            together('We studied 48 hives on 6 rooftops in Kyiv.', 'Ми дослідили 48 вуликів на 6 дахах у Києві.'),
        );
        cue.save('overlay-subtitles.txt', text);
        assertEq(
            together('How many hives did you study?', 'Скільки вуликів ви дослідили?').test(text),
            true,
            'the question and its translation',
        );
        assertEq(
            together('Two seasons, spring to autumn', 'Два сезони, з весни до осені').test(text),
            true,
            'a point, its bullet set as the line’s',
        );
        assertEq(
            together('48 hives, 6 rooftops, 9 percent', '48 вуликів, 6 дахів, 9 відсотків').test(text),
            true,
            'the numbers, their labels taken off',
        );
        assertTextContains(text, /^talk\.md$/, 'the source');
        assertEq(together('talk.md', 'talk.md').test(text), false, 'what reads the same in both is said once');
        assertTextNotContains(text, /^(Цифри|Джерело):/, 'the labels are read in each line’s language');
        assertTextNotContains(text, /^»/, 'no marks of the translation lines');

        // Side by side, chosen while the overlay is as it opens (540 wide, too narrow for two columns): it widens to make room for them, and the
        // answer has a column for each language under its name, the lines side by side.
        const before = (await windowsOf(cue.pid)).windows.find((window) => window.title === 'Cue overlay') ?? fail('no overlay');
        cue.control('answer-layout mirror');
        await cue.waitFor('the setting to be kept', 10, () => /"answerLayout": "mirror"/.test(readSettings(cue.support)));
        await shows(
            'the answer side by side',
            together('English', 'Ukrainian', 'We studied 48 hives on 6 rooftops in Kyiv.', 'Ми дослідили 48 вуликів на 6 дахах у Києві.'),
        );
        cue.save('overlay-mirror.txt', text);
        const widened = (await windowsOf(cue.pid)).windows.find((window) => window.title === 'Cue overlay') ?? fail('no overlay');
        assertEq(widened.width > before.width, true, `wider than it was (${before.width} → ${widened.width} px)`);
        assertEq(widened.left + widened.width, before.left + before.width, 'its right edge where it was');
        assertEq(
            together('Two seasons, spring to autumn', '•', 'Два сезони, з весни до осені').test(text),
            true,
            'a point and its translation, aligned',
        );
        assertEq(together('How many hives did you study?', 'Скільки вуликів ви дослідили?').test(text), true, 'the question as before');

        // Made narrower than two columns need: subtitles.
        await overlayWidth(cue.pid, 480);
        await cue.waitFor('the columns to go', 30, async () => !/^Ukrainian$/m.test((text = await windowText(cue.pid))));
        cue.save('overlay-mirror-narrow.txt', text);
        assertEq(
            together('We studied 48 hives on 6 rooftops in Kyiv.', 'Ми дослідили 48 вуликів на 6 дахах у Києві.').test(text),
            true,
            'subtitles',
        );

        // Wider again: the columns are back.
        await overlayWidth(cue.pid, 760);
        await shows('the columns again', together('English', 'Ukrainian'));

        // Focus: the answer as with one language, then every translation in one paragraph after the language's code.
        cue.control('answer-layout focus');
        await shows('the answer in focus', /^UK · Ми дослідили 48 вуликів на 6 дахах у Києві\. Два сезони, з весни до осені\. /m);
        cue.save('overlay-focus.txt', text);
        assertTextContains(text, /^UK · .* Цифри: 48 вуликів, 6 дахів, 9 відсотків\. Джерело: talk\.md$/, 'the numbers and the source too');
        assertEq(
            together('We studied 48 hives on 6 rooftops in Kyiv.', 'Ми дослідили 48 вуликів на 6 дахах у Києві.').test(text),
            false,
            'no subtitles',
        );
        assertTextContains(text, /^Two seasons, spring to autumn$/);
        assertTextNotContains(text, /^Два сезони, з весни до осені$/, 'no line of its own for a translation');

        // One language: the next answer is in it alone.
        cue.control('languages en');
        await cue.waitLog(/🌐 Languages: English$/, 30);
        cue.control('ask How long did the study run?');
        await cue.waitLog(/❓ \*\*Question:\*\* How long did the study run\?/, 60);
        await cue.waitFor('the second answer', 60, () => cue.logCount(/Answer\*\* \(/) >= 2);
        await shows(
            'the answer in one language',
            together(
                'How long did the study run?',
                'Say',
                'We studied 48 hives on 6 rooftops in Kyiv.',
                '•',
                'Two seasons, spring to autumn',
            ),
        );
        cue.save('overlay-one-language.txt', text);
        assertTextNotContains(text, /^UK · /, 'no translations');
        assertTextNotContains(text, /Ми дослідили|Два сезони/, 'nothing in Ukrainian but the first question, listed as answered');
        const second = readFileSync(cue.sessionLog(), 'utf8').split('How long did the study run?').at(-1) ?? '';
        assertEq(second.includes('» '), false, 'and Claude was asked for no translation');
    },
);

/** The settings file the app keeps under CUE_HOME. */
function readSettings(support: string): string {
    try {
        return readFileSync(join(support, 'settings.json'), 'utf8');
    } catch {
        return '';
    }
}
