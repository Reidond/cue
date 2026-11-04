import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    assertContains,
    assertEq,
    assertNotContains,
    assertTextContains,
    assertTextNotContains,
    e2eCase,
    fail,
    makeNotes,
    press,
    print,
    recordCall,
    waitForNote,
    windowText,
} from '../harness/index.ts';

/** The second pass's words for the default recording of `recordCall`: the call side speaks first and last, two voices. */
const RECORDED = JSON.stringify({
    me: ['We studied 48 hives on six rooftops in Kyiv.'],
    others: [
        { text: 'Thank you for the talk. How many hives did you study?', speaker: 0 },
        { text: 'And how did the bees do over the winter?', speaker: 1 },
    ],
});

const SUMMARY = `# Rooftop bees in Kyiv

## Summary
Andrii presented the rooftop bee study: 48 hives on six rooftops in Kyiv over two seasons. Participant 1 asked how big it was, Participant 2 how the bees did over the winter.

## Key points
- Winter losses were 9 percent, below the national average
- The hives were watched from spring to autumn

## Action items
- [ ] Andrii: send the slides to Participant 1 (Friday)

<!-- speaker: Participant 1 = Olena Mulesa -->
<!-- speaker: Participant 2 = Petro Ivanenko -->
`;

const TRANSLATED_SUMMARY = `## Підсумок
Andrii представив дослідження бджіл на дахах: 48 вуликів на шести дахах у Києві протягом двох сезонів. Participant 1 запитала, наскільки воно велике, Participant 2 — як бджоли пережили зиму.

## Головне
- Зимові втрати становили 9 відсотків, менше за середній показник по країні
- За вуликами спостерігали з весни до осені

## Завдання
- [ ] Andrii: надіслати слайди Participant 1 (п’ятниця)
`;

const TRANSLATIONS = {
    'Rooftop bees in Kyiv': 'Бджоли на дахах Києва',
    'Thank you for the talk. How many hives did you study?': 'Дякую за доповідь. Скільки вуликів ви дослідили?',
    'We studied 48 hives on six rooftops in Kyiv.': 'Ми дослідили 48 вуликів на шести дахах у Києві.',
    'And how did the bees do over the winter?': 'А як бджоли пережили зиму?',
};

/** Lines of a window's text, one after another (UI Automation reads a window's elements in order). */
const together = (...lines: string[]) =>
    new RegExp(`^${lines.map((line) => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\n')}$`, 'm');

/** This PC's note from before it had an account, with a translation in it (as a note restored elsewhere would have): it goes up without it. */
const OLD_NOTE = `---
title: "Weekly beekeeping sync"
date: 2026-10-24T09:05:00Z
duration: 1 min
participants: Andrii, Participant
project: "Rooftop"
translation: uk
---

# Weekly beekeeping sync

## Summary
Andrii will send the hive count by Friday.

<!-- cue:translation uk -->
# Щотижнева зустріч бджолярів

## Підсумок
Андрій надішле кількість вуликів до п’ятниці.
<!-- /cue:translation -->

<!-- transcript -->
## Transcript

**00:00:01 · Participant**
When will the hive count be ready?
> Коли буде готовий підрахунок вуликів?

**00:00:05 · Andrii**
I will send it by Friday.
> Я надішлю його до п’ятниці.
`;

e2eCase(
    'Cue for Windows: a note in two languages keeps its translation in the Markdown file (a block after the summary, a "> " line under each turn) and ' +
        'its page switches between the languages, hides the translated lines, or shows one after the other; renames reach the translation, and a ' +
        'note imported from this PC goes up without it.',
    async (cue) => {
        await cue.defaults('speakerName', 'Andrii');
        cue.standIns({
            FAKE_DEEPGRAM_FILE: RECORDED,
            FAKE_CLAUDE_SUMMARY: cue.save('summary.md', SUMMARY),
            FAKE_CLAUDE_TRANSLATED_SUMMARY: cue.save('translated-summary.md', TRANSLATED_SUMMARY),
            FAKE_CLAUDE_TRANSLATIONS: JSON.stringify(TRANSLATIONS),
        });
        // The account's note, made as another PC would have, with two languages chosen.
        const backend = await cue.backend();
        const recorded = await recordCall(cue, backend, cue.email);
        const put = await backend.call('PUT', '/v1/me/languages', recorded.token, { body: { languages: ['en', 'uk'] } });
        assertEq(put.status, 200);
        const started = await makeNotes(backend, recorded);
        const made = await waitForNote(cue, backend, recorded.token, started.id);
        assertEq(made.translation?.title, 'Бджоли на дахах Києва', 'the account translated it');

        // This PC's old note, in a project of its own.
        const rooftop = await cue.project('Rooftop', { language: 'en' });
        await mkdir(join(rooftop, 'Notes'), { recursive: true });
        const old = join(rooftop, 'Notes', '2026-10-24 11.05 – Weekly beekeeping sync.md');
        await writeFile(old, OLD_NOTE);

        await cue.launch();
        await cue.waitLog(/🌐 Languages: English, Ukrainian$/, 60);
        await cue.waitLog(/📦 Imported 1 note from this PC/, 60);
        await cue.waitLog(/☁️ Restored 1 note from your account/, 60);

        // The imported note is in the account without the translation.
        const account = await backend.accountOf(cue.email);
        const imported =
            (await account.notes()).find((note) => note.title === 'Weekly beekeeping sync') ?? fail('the old note was not imported');
        assertEq(imported.summary.trim(), '## Summary\nAndrii will send the hive count by Friday.', 'its summary alone');
        assertEq(
            imported.transcript.map((turn) => turn.text).join(' | '),
            'When will the hive count be ready? | I will send it by Friday.',
            'its turns alone',
        );

        // The file: the translation after the summary, a "> " line under each turn.
        const file = cue.findNotes().find((path) => path !== old) ?? fail('the restored note is not in the library');
        const markdown = readFileSync(file, 'utf8');
        cue.save('note.md', markdown);
        assertContains(file, /^translation: uk$/);
        assertContains(file, /^<!-- cue:translation uk -->$/);
        assertContains(file, /^# Бджоли на дахах Києва$/);
        assertContains(file, /^<!-- \/cue:translation -->$/);
        assertEq(
            /^## Summary\n[\s\S]*<!-- \/cue:translation -->\n\n<!-- transcript -->\n## Transcript\n/m.test(markdown),
            true,
            'the block between the summary and the transcript',
        );
        assertEq(
            together(
                '**00:00:01 · Participant 1**',
                'Thank you for the talk. How many hives did you study?',
                '> Дякую за доповідь. Скільки вуликів ви дослідили?',
            ).test(markdown),
            true,
            'a turn and its translation',
        );
        assertEq(
            together(
                '**00:00:05 · Andrii**',
                'We studied 48 hives on six rooftops in Kyiv.',
                '> Ми дослідили 48 вуликів на шести дахах у Києві.',
            ).test(markdown),
            true,
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

        // Switch between them (the default): the note's own language first.
        cue.control('size 1100 1400');
        cue.control('page Bee talk/notes');
        // The switch is the note page's alone (Home lists the note's title too, under Recent Notes).
        await shows('the note in English', together('English', 'Українська'));
        assertEq(together('Rooftop bees in Kyiv').test(text), true, 'the note is open');
        cue.save('page-english.txt', text);
        assertEq(together('English', 'Українська').test(text), true, 'the switch, the note’s language first');
        assertTextContains(text, /^Andrii presented the rooftop bee study/, 'the summary');
        assertTextNotContains(text, /^Бджоли на дахах Києва$/, 'not the translated title');
        assertTextContains(text, /^Translations$/, 'the Translations switch');
        assertEq(
            together('Thank you for the talk. How many hives did you study?', 'Дякую за доповідь. Скільки вуликів ви дослідили?').test(
                text,
            ),
            true,
            'each line, its translation under it',
        );

        // The other language: the translated title and summary, the translation first and the original under it.
        cue.control('note-language uk');
        await shows('the note in Ukrainian', together('Бджоли на дахах Києва'));
        cue.save('page-ukrainian.txt', text);
        assertTextContains(text, /^Підсумок$/);
        assertTextNotContains(text, /^Andrii presented the rooftop bee study/, 'not the English summary');
        assertEq(
            together('Дякую за доповідь. Скільки вуликів ви дослідили?', 'Thank you for the talk. How many hives did you study?').test(
                text,
            ),
            true,
            'the translation first',
        );

        // Translations off: one language in the transcript.
        await press(cue.pid, 'Translations');
        await cue.waitFor('the originals to go', 30, async () => !/^Thank you for the talk/m.test((text = await windowText(cue.pid))));
        assertTextContains(text, /^Дякую за доповідь\. Скільки вуликів ви дослідили\?$/);
        cue.control('note-language en');
        // By the English summary: the notes list shows the title in English on either page.
        await shows('the note in English, alone', /^Andrii presented the rooftop bee study/m);
        assertTextContains(text, /^Thank you for the talk\. How many hives did you study\?$/);
        assertTextNotContains(text, /^Дякую за доповідь/, 'no translated lines');
        await press(cue.pid, 'Translations');
        await shows(
            'the translated lines again',
            together('Thank you for the talk. How many hives did you study?', 'Дякую за доповідь. Скільки вуликів ви дослідили?'),
        );

        // One after another: the summary, then the translated one under the language's name, then the transcript with the translations.
        cue.control('note-layout both');
        await shows('the note one after another', /^Українська\nПідсумок$/m);
        cue.save('page-both.txt', text);
        assertTextNotContains(text, /^Translations$/, 'no switch for the lines');
        assertEq(
            /^Rooftop bees in Kyiv$[\s\S]*^Andrii presented[\s\S]*^Українська$[\s\S]*^Зимові втрати[\s\S]*^Transcript$[\s\S]*^Дякую за доповідь/m.test(
                text,
            ),
            true,
            'in that order',
        );
        assertEq(together('English', 'Українська').test(text), false, 'no switch');

        // A rename reaches the translation; the file keeps its block and its lines.
        cue.control('rename Participant 1 | Olena Mulesa');
        await cue.waitLog(/✏️ Renamed “Participant 1” to “Olena Mulesa” in Rooftop bees in Kyiv$/, 30);
        const renamed = cue.findNotes().find((path) => path !== old) ?? fail('the note is gone');
        assertContains(renamed, /^\*\*00:00:01 · Olena Mulesa\*\*$/);
        assertContains(renamed, /Olena Mulesa запитала, наскільки воно велике/, 'in the translated summary');
        assertContains(renamed, /^> Дякую за доповідь\. Скільки вуликів ви дослідили\?$/);
        assertNotContains(renamed, /Participant 1/);
        await shows('the new name on the page', /Olena Mulesa запитала, наскільки воно велике/);
        const stored = await account.note(started.id);
        assertEq(stored.translation?.summary.includes('Olena Mulesa запитала'), true, 'and in the account');
    },
);
