import { assertContains, assertNotContains, e2eCase, fixture, sleep } from '../harness/index.ts';

e2eCase('Switching the project from the overlay changes which materials Cue answers from, and is remembered.', async (cue) => {
    const solar = cue.save(
        'solar.md',
        `# Solar panels on the school roof

The school installed 120 panels in 2025; they cover 70 percent of its power.

Q: How many panels are on the roof?
A: There are 120 panels, covering 70 percent of the school's power.
`,
    );

    await cue.launch();
    cue.control('new Bees');
    cue.control(`add ${fixture('materials', 'talk.md')}`);
    cue.control('new Solar');
    cue.control(`add ${solar}`);
    await cue.waitLog(/Added talk\.md to Bees/, 20);
    await cue.waitLog(/Added solar\.md to Solar/, 20);

    // The prompt Claude was last started with.
    const latestSystem = (): string => cue.claudeRequests('answer-system').at(-1) ?? '';

    cue.control('start Bees');
    await cue.waitLog(/Materials for Bees .*talk\.md/, 30);
    await cue.waitFor('Claude started with the Bees materials', 20, () => latestSystem().includes('48 hives'));
    cue.control('ask How many hives did you study?');
    await cue.waitLog(/Question:.*How many hives.*prepared match/, 20);
    const bees = cue.save('bees.txt', latestSystem());
    assertContains(bees, /48 hives on 6 rooftops/);
    assertNotContains(bees, /120 panels/);

    cue.control('project Solar');
    await cue.waitLog(/Project: Solar/, 10);
    await cue.waitLog(/Materials for Solar .*solar\.md/, 30);
    await cue.waitFor('Claude restarted with the Solar materials', 20, () => latestSystem().includes('120 panels'));
    const solarSystem = cue.save('solar-system.txt', latestSystem());
    assertNotContains(solarSystem, /48 hives/, "the other project's materials must be gone");
    cue.control('ask How many panels are on the roof?');
    await cue.waitLog(/Question:.*How many panels.*prepared match/, 20);
    await cue.waitFor('the second answer', 30, () => cue.logCount(/Answer\*\* \(/) >= 2);

    // The next launch is bound to the project used last.
    await cue.stop();
    await sleep(1); // session logs are named by the second
    await cue.launch();
    await cue.waitLog(/Project: Solar/, 10);
    await cue.waitLog(/Materials for Solar .*solar\.md/, 30);
});
