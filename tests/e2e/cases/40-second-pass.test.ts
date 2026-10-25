import {
    assertContains, assertEq, assertFile, CLAUDE, countLines, dialogue, e2eCase, fail, fixture, lines, matches,
    needWhisper, readText,
} from '../harness/index.ts';

e2eCase("After Stop, whisper-cli reads each side's whole recording again, at background priority, with beam search "
    + "and the project's language, occasion and names and terms; its transcript replaces the live one in the note, "
    + 'both sides merged by time, before the summary is written.', async (cue) => {
    needWhisper();
    const whisperCli = await cue.whisperCliSpy();

    await cue.defaults('speakerName', 'Андрій Тест');
    await cue.defaults('autoAnswer', false);
    await cue.project('Звіт', {
        language: 'uk', occasion: 'Щотижнева зустріч щодо звіту',
        namesAndTerms: 'Олена Мулеса, узгодженість даних, Київ',
    });
    const call = await dialogue(fixture('dialogues', 'deadline-uk.txt'), cue.path('call'));
    await cue.launch({
        CUE_PROJECT: 'Звіт', CUE_REHEARSE_RECORD: '1', CUE_WHISPER_CLI: whisperCli,
        CUE_REHEARSE_PARTICIPANT: call.wav('call'), CUE_REHEARSE_ME: call.wav('me'),
    });
    await cue.waitLog(/Notes ready/, 180);

    // The steps, in order: the live transcript and the audio first, then the second pass, then the summary.
    const steps = matches(cue.sessionLog(),
        /Transcript saved|Audio saved|Working audio:|Improving transcript…|Transcript improved|Writing summary…|Notes ready|Working audio removed/,
    ).join(',');
    assertEq(steps,
        'Transcript saved,Audio saved,Working audio:,Improving transcript…,Transcript improved,Writing summary…,Notes ready,Working audio removed',
        `the note should go through its steps in order: ${steps}`);
    await cue.waitLog(/✅ Transcript improved: [0-9]+ segments \([0-9.]+ s for 0:[0-9]{2} of audio\)/, 1);

    // The second pass's words («п'ятниці» with its apostrophe), each line at the moment it was said in
    // the recording (timeline: 0.50 call, 6.63 me, 12.88 call, 17.28 me, 20.66 call), both speakers.
    const notes = cue.readyNotes();
    assertFile(notes);
    assertContains(notes, /^## Транскрипт$/);
    assertContains(notes, /до п['’ʼ]ятниці/);
    assertContains(notes, /узгодженості даних/);
    assertContains(notes, /^\*\*00:00:00 · Учасник\*\*$/);
    assertContains(notes, /^\*\*00:00:06 · Андрій Тест\*\*$/);
    assertContains(notes, /^\*\*00:00:12 · Учасник\*\*$/);
    assertContains(notes, /^\*\*00:00:17 · Андрій Тест\*\*$/);
    assertContains(notes, /^\*\*00:00:20 · Учасник\*\*$/);
    assertEq(countLines(notes, /^\*\*[0-9]{2}:[0-9]{2}:[0-9]{2} · /), 5, 'each line of the call should be its own turn');

    // How whisper-cli ran: both sides of the working audio, beam search 5, the project's language,
    // its occasion and names and terms as the prompt (for every window), full JSON, low priority.
    const args = cue.path('whisper-args.txt');
    assertFile(args, 'Cue should have run whisper-cli');
    const ran = lines(args);
    const argument = (flag: string): string => (ran.includes(flag) ? ran[ran.indexOf(flag) + 1] ?? '' : '');
    assertEq(argument('-bs'), '5', `whisper-cli should use beam search 5: ${ran.join(' ')}`);
    assertEq(argument('-l'), 'uk', "whisper-cli should listen for the project's language");
    if (!ran.includes('-ojf')) fail(`full JSON output: ${ran.join(' ')}`);
    if (!ran.includes('--carry-initial-prompt')) fail('the prompt should apply to every window');
    assertContains(args, /^Щотижнева зустріч щодо звіту\. Олена Мулеса, узгодженість даних, Київ$/);
    assertContains(args, /\/recordings\/[0-9T-]+Z\/mic\.wav$/);
    assertContains(args, /\/recordings\/[0-9T-]+Z\/call\.wav$/);
    assertEq((readText(cue.path('whisper-priority.txt')) ?? '').replace(/\n+$/, ''), '4',
        'whisper-cli should run at background priority (4)');

    // The summary is written from the improved transcript.
    if (CLAUDE === 'fake') {
        const input = cue.save('summary-input.txt', cue.claudeRequests('summary-input').join(''));
        assertContains(input, /\[Андрій Тест\] .*до п['’ʼ]ятниці/);
    }
});
