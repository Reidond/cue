import { assertContains, assertEq, assertFile, assertNotContains, dialogue, e2eCase, findFiles, fixture } from '../harness/index.ts';

e2eCase(
    "With Keep audio off, a recording's notes have no audio; the sides are still recorded for processing and " +
        'deleted once the notes are ready.',
    async (cue) => {
        await cue.defaults('keepAudio', false);
        await cue.project('Interviews', { language: 'en' });
        const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
        await cue.launch({
            CUE_PROJECT: 'Interviews',
            CUE_REHEARSE_RECORD: '1',
            CUE_SHOW_SETTINGS: '1',
            CUE_SNAPSHOT: cue.path('cue.png'),
            CUE_REHEARSE_PARTICIPANT: call.wav('call'),
            FAKE_DEEPGRAM_LIVE: call.live(),
            FAKE_DEEPGRAM_FILE: call.file(),
            CUE_REHEARSE_ME: call.wav('me'),
        });

        // The preference, in Settings › Notes.
        const settings = cue.save('settings.txt', await cue.snapshotText(cue.path('cue-settings.png')));
        assertContains(settings, /^Keep audio$/);
        assertContains(settings, /about 15 MB per hour/);

        await cue.waitLog(/Transcript saved/, 120);
        await cue.waitLog(/Audio not kept \(Keep audio is off\): [0-9]+:[0-9]{2}/, 10);
        await cue.waitLog(/Working audio: .*\/recordings\//, 10);
        await cue.waitLog(/Notes ready/, 180);
        await cue.waitLog(/Working audio removed: /, 5);

        const notes = cue.readyNotes();
        assertFile(notes);
        assertContains(notes, /^## Transcript/);
        assertNotContains(notes, /^audio:/, "the notes shouldn't name any audio");
        assertNotContains(cue.sessionLog(), /Audio saved/);
        assertEq(findFiles(cue.home, /\.(m4a|wav)$/).length, 0, 'no audio should be left anywhere');

        // The sides went up to be transcribed; the backend deletes them once the notes are ready, and the mixed audio never went up.
        const backend = await cue.backend();
        const account = await backend.accountOf(cue.email);
        await cue.waitFor('the audio to be gone from the account', 30, async () => (await account.notes())[0]?.audio.length === 0);
        assertEq(backend.objects().length, 0, "the backend's storage should hold no audio");
    },
);
