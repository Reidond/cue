import {
    assertContains, assertFile, assertNotContains, CLAUDE, dialogue, e2eCase, fixture, needWhisper, skip,
} from '../harness/index.ts';

e2eCase("The summary is asked for with the project's names and terms and occasion, and with an explicit rule, and a "
    + 'counter-example, against notes about the transcript or speech recognition.', async (cue) => {
    needWhisper();
    if (CLAUDE !== 'fake') skip('checks what Cue sends the fake claude');

    await cue.defaults('speakerName', 'Andrii Test');
    await cue.defaults('autoAnswer', false);
    await cue.project('Beekeeping', {
        language: 'en', occasion: 'Weekly sync about the urban beekeeping report',
        namesAndTerms: 'Olena Mulesa, varroa mites, rooftop apiaries, Київ',
    });
    const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
    await cue.launch({
        CUE_PROJECT: 'Beekeeping', CUE_REHEARSE_RECORD: '1',
        CUE_REHEARSE_PARTICIPANT: call.wav('call'), CUE_REHEARSE_ME: call.wav('me'),
    });
    await cue.waitLog(/Notes ready/, 180);

    const prompt = cue.save('summary-system.txt', cue.claudeRequests('summary-system').join(''));
    assertFile(prompt, 'Cue should have asked for a summary');
    assertContains(prompt,
        /Names and terms that may come up, spelled the way the user writes them: Olena Mulesa, varroa mites, rooftop apiaries, Київ$/);
    assertContains(prompt, /Context the user gave about their current talk .*: Weekly sync about the urban beekeeping report/);
    assertContains(prompt, /Write about the conversation only, never about the transcript/);
    assertContains(prompt, /not in parentheses/);
    assertContains(prompt, /never write «.*\(у транскрипті — „дотатниці“, ймовірно.*\)» — write «Надіслати звіт до п'ятниці»/);
    assertNotContains(prompt, /calendar event/, "a call without a calendar event shouldn't mention one");
});
