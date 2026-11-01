import { assertContains, countLines, dialogue, e2eCase, fixture } from '../harness/index.ts';

e2eCase(
    'While a new note is processed, its page lists the steps — Saving audio, Improving transcript, Writing ' +
        'summary — as they happen; once the notes are ready and nothing failed, the list goes.',
    async (cue) => {
        // A second pass and a summary that take a while, as they do for a long call (FAKE_DEEPGRAM_FILE_DELAY, FAKE_CLAUDE_SUMMARY_DELAY).
        // OCR may read a step's status icon as a character before its name.

        await cue.defaults('speakerName', 'Andrii Test');
        await cue.defaults('autoAnswer', false);
        await cue.project('Interviews', { language: 'en' });
        const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
        await cue.launch({
            CUE_PROJECT: 'Interviews',
            CUE_REHEARSE_RECORD: '1',
            FAKE_DEEPGRAM_FILE_DELAY: '8',
            FAKE_CLAUDE_SUMMARY_DELAY: '20',
            CUE_SNAPSHOT: cue.path('cue.png'),
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            FAKE_DEEPGRAM_LIVE: call.live(),
            FAKE_DEEPGRAM_FILE: call.file(),
            CUE_REHEARSE_ME: call.wav('me'),
        });
        const page = cue.page;

        // Stop opens the note on the dashboard, with its steps on top of the live transcript.
        await cue.waitLog(/🔁 Improving transcript…/, 120);
        await cue.waitFor("the note's steps", 20, () => cue.dashboardShows(/^.{0,3}Improving transcript$/u));
        assertContains(page, /^.{0,3}Saving audio$/u);
        assertContains(page, /^.{0,3}Writing summary$/u);
        assertContains(page, /^Transcript$/);

        await cue.waitLog(/✍️ Writing summary…/, 30);
        await cue.waitFor('the summary step', 20, () => cue.dashboardShows(/^.{0,3}Writing summary$/u));
        assertContains(page, /^.{0,3}Improving transcript$/u);

        await cue.waitLog(/Notes ready/, 60);
        const stepsGone = async (): Promise<boolean> =>
            (await cue.dashboardShows(/^Summary$/)) && countLines(page, /^.{0,3}(Improving transcript|Writing summary)$/u) === 0;
        await cue.waitFor('the steps to leave the page', 20, stepsGone);
        // Wide enough that the summary's sentence isn't wrapped before "Friday", however the Mac draws the text.
        cue.control('size 1400 900');
        await cue.waitFor('the summary', 20, () => cue.dashboardShows(/by Friday/));
    },
);
