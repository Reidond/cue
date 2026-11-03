import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
    assertContains,
    assertDeepEq,
    assertEq,
    assertNotContains,
    assertTextContains,
    assertTextNotContains,
    countLines,
    dialogue,
    e2eCase,
    fail,
} from '../harness/index.ts';

/** A council member asks about the rooftop hives on the call; you answer on the microphone. */
const SCRIPT = `# A two-sided call about the rooftop bees, for a note in English translated into Ukrainian.
call | Daniel   | How many hives did you study?
me   | Samantha | We studied 48 hives on six rooftops in Kyiv.
call | Daniel   | And how many were lost in winter?
me   | Samantha | Nine percent, below the national average.
`;

/** What the summary step writes (Claude's stand-in), and its translation: short, so the transcript under them is on screen on a small display too. */
const SUMMARY = `# Rooftop bees in Kyiv

## Summary
Participant asked about the rooftop hives. Andrii Test said the study covered 48 hives on six rooftops and lost nine percent in winter.
`;
const SUMMARY_UK = `## Підсумок
Participant запитав про вулики на дахах. Andrii Test сказав, що дослідження охопило 48 вуликів на шести дахах, а взимку загинуло дев’ять відсотків.
`;

/** The title and each line of the transcript in Ukrainian. */
const UKRAINIAN: Record<string, string> = {
    'Rooftop bees in Kyiv': 'Бджоли на дахах Києва',
    'How many hives did you study?': 'Скільки вуликів ви дослідили?',
    'We studied 48 hives on six rooftops in Kyiv.': 'Ми дослідили 48 вуликів на шести дахах у Києві.',
    'And how many were lost in winter?': 'А скільки загинуло взимку?',
    'Nine percent, below the national average.': 'Дев’ять відсотків, менше за середній показник по країні.',
};

e2eCase(
    "With two languages a call's notes come in both: the file keeps the translated title and summary in a block after the note's " +
        "own and each line's translation on a `> ` line under it; the note's page switches between the languages or shows them one " +
        'after another; a rename reaches the translation, and a note read back (imported) leaves it out.',
    async (cue) => {
        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        await cue.project('Bee talk', { language: 'en' });
        const call = await dialogue(cue.save('bees.txt', SCRIPT), cue.path('call'));
        await cue.launch({
            CUE_PROJECT: 'Bee talk',
            CUE_REHEARSE_RECORD: '1',
            CUE_SNAPSHOT: cue.path('cue.png'),
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            CUE_REHEARSE_ME: call.wav('me'),
            FAKE_DEEPGRAM_LIVE: call.live(),
            FAKE_DEEPGRAM_FILE: call.file(),
            FAKE_CLAUDE_SUMMARY: cue.save('summary.md', SUMMARY),
            FAKE_CLAUDE_TRANSLATED_SUMMARY: cue.save('summary-uk.md', SUMMARY_UK),
            FAKE_CLAUDE_TRANSLATIONS: JSON.stringify(UKRAINIAN),
        });
        // English and Ukrainian, chosen in the app (as Settings does) while the call is recorded: the notes are made after it.
        cue.control('languages en uk');
        await cue.waitLog(/🌐 Languages: English, Ukrainian$/, 20);
        await cue.waitLog(/📝 Notes ready/, 300);

        // The account's note has its translation, a line for each turn.
        const backend = await cue.backend();
        const account = await backend.accountOf(cue.email);
        const [stored] = await account.notes();
        const translation = stored?.translation ?? fail('the note should have its translation', JSON.stringify(stored));
        assertEq(translation.language, 'uk');
        assertEq(translation.title, 'Бджоли на дахах Києва');
        assertDeepEq(
            translation.transcript,
            stored!.transcript.map((turn) => UKRAINIAN[turn.text] ?? `(no translation of "${turn.text}")`),
            'each turn in Ukrainian, in order',
        );
        const log = cue.sessionLog();
        assertContains(log, /🌐 Translating notes…$/);
        assertContains(log, new RegExp(`✅ Notes translated into Ukrainian: ${stored!.transcript.length} lines$`));

        // The file: the note's own title and summary, then the translated ones in their block, then the transcript, each turn's
        // translation on the line right under it.
        const notes = cue.readyNotes();
        const text = readFileSync(notes, 'utf8');
        assertContains(notes, /^translation: uk$/);
        assertContains(notes, /^# Rooftop bees in Kyiv$/);
        assertContains(notes, /^<!-- cue:translation uk -->$/);
        assertContains(notes, /^# Бджоли на дахах Києва$/);
        assertContains(notes, /^Participant запитав про вулики на дахах\./);
        assertContains(notes, /^<!-- \/cue:translation -->$/);
        const order = [
            '# Rooftop bees in Kyiv',
            '<!-- cue:translation uk -->',
            '## Підсумок',
            '<!-- /cue:translation -->',
            '<!-- transcript -->',
        ];
        const at = order.map((line) => text.indexOf(`\n${line}\n`));
        if (at.some((index, place) => index < 0 || (place > 0 && index < at[place - 1]!))) {
            fail(`the note's parts should come in this order: ${order.join(', ')}`, text);
        }
        for (const [said, translated] of Object.entries(UKRAINIAN).slice(1)) {
            if (!text.includes(`\n${said}\n> ${translated}\n`)) fail(`“${said}” should be followed by “> ${translated}”`, text);
        }
        assertEq(countLines(notes, /^> /), stored!.transcript.length, 'a translation for each turn, and nothing else quoted');

        // Switch between them (the default): the note in English with each line's Ukrainian under it, the switch above it.
        const page = cue.page;
        await cue.dashboardPage('Bee talk/notes', /^Participant asked about the rooftop hives/);
        assertContains(page, /Українська/, 'the switch names the other language in itself');
        assertNotContains(page, /Бджоли на дахах Києва/, 'the translated title is the other language’s');
        // The transcript is below the summary: a window too short to show it is made taller.
        if (countLines(page, /Скільки вуликів ви дослідили/) === 0) cue.control('size 1060 1400');
        await cue.waitFor('the transcript with its translations', 30, () => cue.dashboardShows(/Скільки вуликів ви дослідили/));
        assertContains(page, /Translations/, 'the switch by the transcript’s heading');
        assertContains(page, /How many hives did you study/);
        assertContains(page, /We studied 48 hives on six rooftops/);

        // The other language: the translated title and summary, and each line's translation first with the line as it was said under it.
        let asked = Date.now();
        cue.control('note-language uk');
        await cue.waitFor('the note in Ukrainian', 30, () => cue.dashboardShows(/Бджоли на дахах Києва/, asked));
        assertContains(page, /Participant запитав про вулики на дахах/);
        assertNotContains(page, /^Participant asked about the rooftop hives/, 'the English summary is the other view’s');
        assertContains(page, /Скільки вуликів ви дослідили/);
        assertContains(page, /How many hives did you study/, 'with the line as it was said under it');

        // One after another: the summary, the translated one under the language's name, the transcript with its translations.
        asked = Date.now();
        cue.control('note-layout both');
        await cue.waitFor('the note one language after the other', 30, () =>
            cue.dashboardShows(/^Participant asked about the rooftop hives/, asked),
        );
        assertContains(page, /Українська/, "the translation's heading");
        assertContains(page, /Бджоли на дахах Києва/);
        assertContains(page, /Participant запитав про вулики на дахах/);

        // A rename reaches both languages, and the translations stay under their lines.
        cue.control('rename Participant | Olena Mulesa');
        await cue.waitLog(/✏️ Renamed “Participant” to “Olena Mulesa” in Rooftop bees in Kyiv$/, 30);
        assertContains(notes, /^Olena Mulesa asked about the rooftop hives\./);
        assertContains(notes, /^Olena Mulesa запитав про вулики на дахах\./, 'the translated summary is renamed too');
        assertContains(notes, /^\*\*00:00:[0-9]{2} · Olena Mulesa\*\*$/);
        assertContains(notes, /^> Скільки вуликів ви дослідили\?$/);
        assertContains(notes, /^<!-- cue:translation uk -->$/);

        // A copy of the note the account doesn't know (no `note:`): imported at the next sign-in as the note says it, without its
        // translation, which is the account's to make.
        const renamed = readFileSync(notes, 'utf8');
        writeFileSync(
            join(dirname(notes), '2026-10-01 09.00 – An older copy.md'),
            renamed
                .replace(/^note: .*\n/m, '')
                .replace(/^date: .*$/m, 'date: 2026-10-01T06:00:00Z')
                .replace(/^title: .*$/m, 'title: "An older copy"')
                .replace(/^# Rooftop bees in Kyiv$/m, '# An older copy'),
        );
        await cue.stop();
        await cue.launch({ CUE_PROJECT: 'Bee talk' });
        await cue.waitLog(/📦 Imported 1 note from this Mac$/, 60);
        const imported =
            (await account.notes()).find((note) => note.title === 'An older copy') ??
            fail('the account should have the imported note', JSON.stringify(await account.notes()));
        assertTextContains(imported.summary, /^Olena Mulesa asked about the rooftop hives\./, 'its summary is the note’s own');
        assertTextNotContains(imported.summary, /cue:translation|Підсумок|запитав/, 'and only that');
        assertTextNotContains(imported.summary, /^# /, 'without the translated title');
        assertEq(imported.transcript.length, stored!.transcript.length, 'a turn for each turn');
        assertTextNotContains(
            imported.transcript.map((turn) => turn.text).join('\n'),
            /Скільки|вуликів|^>/,
            'each turn is what was said, without its translation',
        );
    },
);
