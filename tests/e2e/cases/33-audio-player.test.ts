import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    assertContains,
    assertNotContains,
    audioLength,
    dialogue,
    e2eCase,
    exec,
    fail,
    fixture,
    lines,
    literal,
} from '../harness/index.ts';

/** A position as the player shows it, m:ss. */
function clock(seconds: number): string {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

e2eCase(
    'A note with audio opens with a player on top (play, scrubber, speed at 1×), and clicking a timestamp in its ' +
        'transcript plays the audio from that moment.',
    async (cue) => {
        // A note as Cue saves it, with the call's audio next to it.
        const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
        const project = await cue.project('Bee talk', { language: 'en' });
        await mkdir(join(project, 'Notes'), { recursive: true });
        const name = '2026-10-24 14.05 – Weekly sync about the report';
        const audio = await exec('afconvert', [
            '-f',
            'm4af',
            '-d',
            'aac',
            '-b',
            '32000',
            call.wav('call'),
            join(project, 'Notes', `${name}.m4a`),
        ]);
        if (audio.code !== 0) fail("couldn't make the audio", audio.output);
        // How long the voices take to say it differs from Mac to Mac; the player shows it to the second.
        const seconds = (await audioLength(join(project, 'Notes', `${name}.m4a`))) ?? fail("afinfo can't read the audio's length");
        const length = [...new Set([Math.floor(seconds), Math.ceil(seconds)])].map(clock).join('|');
        const note = lines(fixture('notes', 'sample.md')).flatMap((line) =>
            line.startsWith('participants: ') ? [line, `audio: "${name}.m4a"`] : [line],
        );
        await writeFile(join(project, 'Notes', `${name}.md`), note.map((line) => `${line}\n`).join(''));

        const text = cue.page;
        // Vision reads the player's small text most reliably in the light appearance.
        await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png'), CUE_APPEARANCE: 'light' });

        // The player's position and length; Vision reads the play button, or the scrubber's knob next to the
        // position, as a bullet, and × as x (or Cyrillic х).
        const start = /(^|[^0-9:])0:00( •)?$/;
        cue.control('page Bee talk/notes');
        // The length and the speed button next to it may be read as one line.
        await cue.waitFor("the note's player", 20, () => cue.dashboardShows(new RegExp(`(^|\\s)(${length})(\\s|$)`)));
        assertContains(text, /^Summary$/);
        assertContains(text, start, 'the player should start at 0:00');
        assertContains(text, /(^|\s)1 ?(×|x|х)$/, 'the player should play at 1×');
        assertNotContains(text, /m4a/, "the audio file's name belongs in the player, not the note's details");

        // Clicking the participant's timestamp (00:00:12) plays from there.
        cue.control('timestamp 00:00:12');
        await cue.waitLog(new RegExp(`Playing ${literal(name)}\\.m4a from 0:12 \\(player at 12\\.0 s\\)`), 10);
        const later = Array.from({ length: Math.max(Math.ceil(seconds) - 11, 1) }, (_, index) => clock(12 + index)).join('|');
        await cue.waitFor('the player to show 0:12 or later', 10, () => cue.dashboardShows(new RegExp(`(^|[^0-9:])(${later})$`)));
    },
);
