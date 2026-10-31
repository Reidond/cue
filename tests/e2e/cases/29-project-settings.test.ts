import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { assertContains, assertDeepEq, assertEq, e2eCase, isFile, sleep } from '../harness/index.ts';

e2eCase("A project's settings changed on one launch are still there on the next, read from the account.", async (cue) => {
    await cue.launch();
    cue.control('new Bee talk');
    await cue.waitFor('the project', 10, () => isFile(join(cue.projectPath('Bee talk'), 'project.json')));
    cue.control('set Bee talk | occasion | A talk at the city council');
    cue.control('set Bee talk | language | uk');
    cue.control('set Bee talk | names | Varroa, Kyiv; linden');
    await cue.waitLog(/Saved “Bee talk” to your account/, 15);

    const account = await (await cue.backend()).accountOf(cue.email);
    const saved = await account.project('Bee talk');
    assertEq(saved.occasion, 'A talk at the city council', 'the occasion reached the account');
    assertEq(saved.language, 'uk');
    assertDeepEq(saved.terms, ['Varroa', 'Kyiv', 'linden']);

    // The next launch finds nothing of the project on this Mac: its settings come from the account.
    await cue.stop();
    await rm(cue.projectPath('Bee talk'), { recursive: true });
    await sleep(1); // session logs are named by the second
    await cue.launch();
    const json = join(cue.projectPath('Bee talk'), 'project.json');
    await cue.waitFor('the project back from the account', 10, () => isFile(json));
    assertContains(json, /"occasion" : "A talk at the city council"/);
    assertContains(json, /"language" : "uk"/);
    assertContains(json, /"namesAndTerms" : "Varroa, Kyiv; linden"/);
    assertEq((await account.projects()).length, 1, 'and it is still the one project');
});
