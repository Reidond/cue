import {
    assertContains,
    assertEq,
    assertTurnsAt,
    assertFile,
    assertNotContains,
    countLines,
    dialogue,
    e2eCase,
    fail,
    FAKE_KEYS,
    fixture,
    heardReport,
    matches,
    print,
} from '../harness/index.ts';

e2eCase(
    "After Stop, the recording of each side goes up and the backend's Workflow reads it again with Deepgram, with the " +
        "project's language, occasion and names and terms and the call side's voices told apart; its transcript replaces " +
        'the live one in the note, both sides merged by time, before the summary is written.',
    async (cue) => {
        await cue.defaults('speakerName', 'Андрій Тест');
        await cue.defaults('autoAnswer', false);
        await cue.project('Звіт', {
            language: 'uk',
            occasion: 'Щотижнева зустріч щодо звіту',
            namesAndTerms: 'Олена Мулеса, узгодженість даних, Київ',
        });
        const call = await dialogue(fixture('dialogues', 'deadline-uk.txt'), cue.path('call'));
        // Live recognition gets the two phrases wrong that the recording gets right.
        const live = call.live().replaceAll("до п'ятниці", 'дотатниці').replaceAll('узгодженості', 'у згодженості');
        await cue.launch({
            CUE_PROJECT: 'Звіт',
            CUE_REHEARSE_RECORD: '1',
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            FAKE_DEEPGRAM_LIVE: live,
            FAKE_DEEPGRAM_FILE: call.file(),
            CUE_REHEARSE_ME: call.wav('me'),
        });
        await cue.waitLog(/Notes ready/, 180);

        // The steps, in order: the live transcript and the audio first, then the upload, the second pass, then the summary.
        const steps = matches(
            cue.sessionLog(),
            /Transcript saved|Audio saved|Working audio:|Uploading the recording…|Recording uploaded|Improving transcript…|Transcript improved|Writing summary…|Notes ready|Working audio removed/,
        ).join(',');
        assertEq(
            steps,
            'Transcript saved,Audio saved,Working audio:,Uploading the recording…,Recording uploaded,Improving transcript…,Transcript improved,Writing summary…,Notes ready,Working audio removed',
            `the note should go through its steps in order: ${steps}`,
        );
        await cue.waitLog(/✅ Transcript improved: [0-9]+ segments \([0-9.]+ s for 0:[0-9]{2} of audio\)/, 1);

        // The second pass's words («п'ятниці» with its apostrophe), each line at the moment it was said in
        // the recording (each turn where the timeline puts its line), both speakers.
        const notes = cue.readyNotes();
        assertFile(notes);
        print(heardReport(call.timeline, cue.serviceRequests('deepgram-file')));
        assertContains(notes, /^## Транскрипт$/);
        assertContains(notes, /до п['’ʼ]ятниці/);
        assertContains(notes, /узгодженості даних/);
        assertNotContains(notes, /дотатниці|у згодженості/, "the live recognition's mistakes should be replaced");
        assertTurnsAt(notes, call.timeline, ['Учасник', 'Андрій Тест', 'Учасник', 'Андрій Тест', 'Учасник']);
        assertEq(countLines(notes, /^\*\*[0-9]{2}:[0-9]{2}:[0-9]{2} · /), 5, 'each line of the call should be its own turn');

        // How the backend asked Deepgram: one request per side, the owner's key, Nova-3, the project's language, its terms, voices told apart on the call side only.
        const asked = cue.serviceRequests('deepgram-file');
        assertEq(asked.length, 2, 'the two sides should each be read once');
        const bySide = Object.fromEntries(asked.map((request) => [request.side, request]));
        for (const side of ['me', 'others']) {
            const request = bySide[side] ?? fail(`Deepgram should have been asked about the ${side} side`, JSON.stringify(asked));
            assertEq(request.key, FAKE_KEYS.deepgram, "the owner's key, not the user's token");
            assertEq(request.query['model'], 'nova-3');
            assertEq(request.query['language'], 'uk', "the project's language");
            assertEq(
                request.keyterms.includes('Олена Мулеса') && request.keyterms.includes('узгодженість даних'),
                true,
                'the names and terms',
            );
            if (request.seconds < 20) fail(`the whole recording should go up, not ${request.seconds} s of it`);
            assertEq(JSON.stringify(request.headers).includes('Bearer'), false, "the user's token never reaches Deepgram");
        }
        assertEq(bySide['others']?.query['diarize'], 'true', 'the call side is diarized');
        assertEq(bySide['me']?.query['diarize'] === 'true', false, 'your side is just you');

        // The summary is written from the improved transcript.
        const input = cue.save('summary-input.txt', cue.claudeRequests('summary-input').join(''));
        assertContains(input, /\[Андрій Тест\] .*до п['’ʼ]ятниці/);
    },
);
