import { accountProject, assertNotContains, bursts, e2eCase, exec, fail, needAudioOutput } from '../harness/index.ts';

e2eCase(
    'Cue for Windows: Cue hears what the PC plays (WASAPI loopback of everything but its own sound) and the live transcript shows it; Stop Cue and ' +
        'Quit close the audio cleanly, and Start Cue opens it again.',
    async (cue) => {
        await needAudioOutput();
        await accountProject(cue, 'Bees');
        await cue.defaults('autoAnswer', false);
        const sound = await bursts(cue.path('sound.wav'), 3, [[0.3, 2.5]]);
        // The real capture: no CUE_NO_LIVE_AUDIO, no rehearsal file. The harness has no microphone to give it; the call's audio is whatever the PC plays.
        await cue.launch({ CUE_PROJECT: 'Bees', CUE_NO_LIVE_AUDIO: '0', FAKE_DEEPGRAM_LIVE: JSON.stringify(['The PC played this line.']) });
        cue.control('start Bees');
        await cue.waitLog(/🔊 Call audio: /, 30);
        await cue.waitLog(/🧐 Question judge ready: Claude Haiku/, 90);

        // Another program plays the sound through the default speakers, as a call app would.
        const played = await exec('powershell.exe', [
            '-NoProfile',
            '-Command',
            `(New-Object System.Media.SoundPlayer '${sound}').PlaySync()`,
        ]);
        if (played.code !== 0) fail('playing the sound failed', played.output);
        await cue.waitLog(/\*\*\[Participant\]\*\* The PC played this line\./, 60);

        // Stop Cue closes the audio, Start Cue opens it again.
        cue.control('stop');
        await cue.waitLog(/🎤 Listening stopped/, 30);
        cue.control('start Bees');
        await cue.waitFor('the call audio to open again', 30, () => cue.logCount(/🔊 Call audio: /) === 2);

        // And Quit lets go of everything: nothing in the log says it didn't.
        await cue.stop();
        assertNotContains(cue.sessionLog(), /failed|Unexpected error|Couldn't/);
    },
);
