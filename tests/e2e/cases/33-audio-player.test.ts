import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    assertContains, assertNotContains, dialogue, e2eCase, exec, fail, fixture, lines, literal,
} from '../harness/index.ts';

e2eCase('A note with audio opens with a player on top (play, scrubber, 1×/1.5×/2×), and clicking a timestamp in its '
    + 'transcript plays the audio from that moment.', async (cue) => {
    // A note as Cue saves it, with the call's audio next to it.
    const call = await dialogue(fixture('dialogues', 'sync.txt'), cue.path('call'));
    const project = await cue.project('Bee talk', { language: 'en' });
    await mkdir(join(project, 'Notes'), { recursive: true });
    const name = '2026-10-24 14.05 – Weekly sync about the report';
    const audio = await exec('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '32000', call.wav('call'), join(project, 'Notes', `${name}.m4a`)]);
    if (audio.code !== 0) fail("couldn't make the audio", audio.output);
    const note = lines(fixture('notes', 'sample.md'))
        .flatMap((line) => (line.startsWith('participants: ') ? [line, `audio: "${name}.m4a"`] : [line]));
    await writeFile(join(project, 'Notes', `${name}.md`), note.map((line) => `${line}\n`).join(''));

    const text = cue.page;
    await cue.launch({ CUE_SNAPSHOT: cue.path('cue.png') });

    // The player's position and length; Vision reads the play button as a bullet, × as x (or Cyrillic х).
    const start = /(^|[^0-9:])0:00$/;
    cue.control('page Bee talk/notes');
    await cue.waitFor("the note's player", 20, () => cue.dashboardShows(/^0:16$/));
    assertContains(text, /^Summary$/);
    assertContains(text, start, 'the player should start at 0:00');
    assertContains(text, /^1 ?(×|x|х)$/, 'the player should offer 1×');
    assertContains(text, /1[.,]5 ?(×|x|х)/, 'the player should offer 1.5×');
    assertContains(text, /(^| )2 ?(×|x|х)$/, 'the player should offer 2×');
    assertNotContains(text, /m4a/, "the audio file's name belongs in the player, not the note's details");

    // Clicking the participant's timestamp (00:00:12) plays from there.
    cue.control('timestamp 00:00:12');
    await cue.waitLog(new RegExp(`Playing ${literal(name)}\\.m4a from 0:12 \\(player at 12\\.0 s\\)`), 10);
    await cue.waitFor('the player to show 0:12 or later', 10, () => cue.dashboardShows(/(^|[^0-9:])0:1[2-6]$/));
});
