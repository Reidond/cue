import {
    assertBetween,
    assertNotContains,
    audioLength,
    e2eCase,
    excerpt,
    fail,
    needRealDeepgram,
    print,
    readText,
    skip,
} from '../harness/index.ts';

// A recording of a real call is someone's conversation: it stays outside the repository, and this case runs
// only where one is given (E2E_REAL_CALL=path, any recording macOS can read, a screen recording's .mov too).
const recording = process.env['E2E_REAL_CALL'];

e2eCase(
    'With the real Deepgram behind the backend, two minutes of a real Ukrainian call are transcribed live, line by line as ' +
        'people pause, in sentence-long lines rather than a word or two each.',
    async (cue) => {
        await needRealDeepgram();
        if (!recording) skip('set E2E_REAL_CALL to a recording of a real call, kept outside the repository');

        await cue.defaults('speakerName', 'Андрій Тест');
        await cue.defaults('autoAnswer', false);
        await cue.project('Дзвінок', { language: 'uk' });
        const call = await excerpt(recording, cue.path('call.wav'), 0, 120);
        assertBetween(await audioLength(call), 110, 121, 'two minutes of the call');
        await cue.launch({ CUE_PROJECT: 'Дзвінок', CUE_REHEARSE_RECORD: '1', CUE_REHEARSE_PARTICIPANT: call });
        await cue.waitLog(/Transcript saved/, 200);

        const log = cue.sessionLog();
        assertNotContains(log, /Speech recognition unavailable/);
        const live = cue.logCount(/\*\*\[Participant\]\*\* \S/);
        if (live < 8) fail(`two minutes of talk should give at least 8 live lines, got ${live}`);

        // The backend asks Deepgram to end an utterance after 0.7 s of quiet: lines of a sentence or so, not a word or two each.
        const words = (readText(cue.sessionLog()) ?? '')
            .split('\n')
            .filter((line) => /^\*\*\[Participant\]\*\* \S/.test(line))
            .map((line) => line.replace(/^\*\*\[Participant\]\*\* /, '').split(/\s+/).length);
        const average = words.reduce((total, count) => total + count, 0) / words.length;
        print(`${live} live lines, ${average.toFixed(1)} words each`);
        assertBetween(average, 4, 40, 'sentence-long lines, not a word or two each');
        if (!/[іїєґ]/i.test(log)) fail('the transcript should be in Ukrainian', log);
    },
);
