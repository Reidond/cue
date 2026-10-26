import {
    assertBetween, assertContains, assertNotContains, audioLength, e2eCase, excerpt, fail, needRealDeepgram, print, readText, skip,
} from '../harness/index.ts';

// A recording of a real call is someone's conversation: it stays outside the repository, and this case runs
// only where one is given (E2E_REAL_CALL=path, any recording macOS can read, a screen recording's .mov too).
const recording = process.env['E2E_REAL_CALL'];

e2eCase('With the real Deepgram, two minutes of a real Ukrainian call are transcribed live, line by line as people '
    + 'pause, and again after the recording in sentence-long segments rather than a word or two each.', async (cue) => {
    await needRealDeepgram();
    if (!recording) skip('set E2E_REAL_CALL to a recording of a real call, kept outside the repository');

    await cue.defaults('speakerName', 'Андрій Тест');
    await cue.defaults('autoAnswer', false);
    await cue.defaults('speechProvider', 'deepgram');
    await cue.apiKey('deepgram');
    await cue.project('Дзвінок', { language: 'uk' });
    const call = await excerpt(recording, cue.path('call.wav'), 0, 120);
    assertBetween(await audioLength(call), 110, 121, 'two minutes of the call');
    await cue.launch({ CUE_PROJECT: 'Дзвінок', CUE_REHEARSE_RECORD: '1', CUE_REHEARSE_PARTICIPANT: call });
    await cue.waitLog(/Transcript saved/, 200);
    await cue.waitLog(/Notes ready/, 120);

    const log = cue.sessionLog();
    assertNotContains(log, /Speech recognition unavailable|Couldn't improve the transcript/);
    const live = cue.logCount(/\*\*\[Participant\]\*\* \S/);
    if (live < 8) fail(`two minutes of talk should give at least 8 live lines, got ${live}`);

    // Deepgram's own split (pauses of 0.8 s) gives about one segment every 3.5 s of such a call; Cue's,
    // 1.6 s, one every 7 s or so.
    const improved = /Transcript improved: ([0-9]+) segments \(.* for ([0-9]+):([0-9]{2}) of audio\)/.exec(readText(log) ?? '')
        ?? fail("the session log doesn't say how the transcript was improved");
    const minutes = (Number(improved[2]) * 60 + Number(improved[3])) / 60;
    print(`${live} live lines; ${improved[1]} segments after the second pass, for ${minutes.toFixed(1)} min`);
    assertBetween(Number(improved[1]) / minutes, 2, 12, 'sentence-long segments, not a word or two each');
    const notes = readText(cue.readyNotes()) ?? fail('no notes');
    const transcript = notes.split(/^## Транскрипт$/m)[1] ?? fail('the notes have no transcript');
    if (!/[іїєґ]/i.test(transcript)) fail('the transcript should be in Ukrainian', transcript);
    // One voice is «Учасник»; told apart, they are «Учасник 1», «Учасник 2».
    assertContains(cue.readyNotes(), /^\*\*00:00:[0-9]{2} · Учасник( [0-9]+)?\*\*/);
});
