import { assertContains, assertEq, countLines, e2eCase, fail, fixture } from '../harness/index.ts';

e2eCase('`Cue --inspect` reads a materials file and finds its prepared answers.', async (cue) => {
    const inspect = await cue.cli('--inspect', fixture('materials', 'talk.md'));
    const out = cue.save('inspect.txt', inspect.output);
    if (inspect.code !== 0) fail(`--inspect exited with ${inspect.code}`);
    assertContains(out, /^talk\.md: /);
    assertContains(out, /Q: How many hives did you study/);
    assertContains(out, /A: We studied 48 hives on 6 rooftops/);
    assertContains(out, /Q: What were the winter losses/);
    assertEq(countLines(out, /^  Q/), 3, 'expected 3 prepared answers');
});
