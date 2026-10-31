import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { assertContains, assertFile, countLines, e2eCase, exec, matches, needReachable, print, SPEAKER_FILES } from '../harness/index.ts';

e2eCase(
    "Home's checklist has the speaker models, like the speech model: their download size while they are missing, " +
        'and Download, which fetches them from Hugging Face with progress; then the row is done.',
    async (cue) => {
        await needReachable('https://huggingface.co', 'Hugging Face');

        const models = cue.path('speaker-models');
        await mkdir(models, { recursive: true });
        await cue.launch({ CUE_SPEAKER_MODELS: models, CUE_SNAPSHOT: cue.path('cue.png') });
        const page = cue.page;

        await cue.dashboardPage('home', /Speaker models$/);
        assertContains(page, /^Finish Setting Up$/);
        assertContains(page, /^[0-9]+ MB download, stays on this Mac/);
        assertContains(page, /Speech model$/);

        cue.control('download speakers');
        await cue.waitLog(/👥 Downloading speaker models…/, 10);
        await cue.waitLog(/👥 Speaker models downloaded: [0-9.]+ MB \([0-9.]+ s\)/, 300);
        for (const file of SPEAKER_FILES) {
            assertFile(join(models, 'speaker-diarization', file), `the download should have ${file}`);
        }
        const onDisk = (await exec('du', ['-sh', join(models, 'speaker-diarization')])).stdout.split('\t')[0];
        print(`Speaker models: ${onDisk} on disk; ${matches(cue.sessionLog(), /Speaker models downloaded: .*/).join('\n')}`);

        // The row is done: no download left to offer (the card goes once everything is set up).
        const downloaded = async (): Promise<boolean> =>
            (await cue.dashboardShows(/Tell the people on a call apart|Recent Notes|Create Your First Project/)) &&
            countLines(page, /MB download, stays on this Mac/) === 0;
        await cue.waitFor("the speaker models' row to be done", 20, downloaded);
    },
);
