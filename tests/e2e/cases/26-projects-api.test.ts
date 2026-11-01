import { assertDeepEq, assertEq, e2eCase } from '../harness/index.ts';

interface Project {
    id: string;
    name: string;
    occasion: string;
    language: string;
    namesAndTerms: string;
    terms: string[];
    lastUsedAt: number | null;
    materialCount: number;
}

e2eCase('Projects are kept in the account with all their settings, and each person sees only their own.', async (cue) => {
    const backend = await cue.backend();
    const ann = 'ann@cue.test';
    const bob = 'bob@cue.test';
    await backend.invite(ann);
    await backend.invite(bob);
    const [a, b] = [(await backend.tokensFor(ann)).access_token, (await backend.tokensFor(bob)).access_token];

    assertEq((await backend.call('GET', '/v1/projects', 'not-a-token')).status, 401, 'a request without a good token');
    assertEq((await backend.call('GET', '/v1/projects', a)).body.projects.length, 0, 'a new account has no projects');

    // Create: every setting a project has.
    const created = await backend.call('POST', '/v1/projects', a, {
        body: {
            name: ' Bee talk ',
            language: 'uk',
            occasion: 'A PhD pre-defense',
            namesAndTerms: 'Varroa, Kyiv; Linden.\nTetiana Kovalenko',
        },
    });
    assertEq(created.status, 201, 'creating a project');
    const project = created.body as Project;
    assertEq(project.name, 'Bee talk', 'the name is trimmed');
    assertEq(project.language, 'uk');
    assertEq(project.occasion, 'A PhD pre-defense');
    assertDeepEq(project.terms, ['Varroa', 'Kyiv', 'Linden', 'Tetiana Kovalenko'], 'names and terms, one by one');
    assertEq(project.materialCount, 0);
    assertEq((await backend.call('POST', '/v1/projects', a, { body: { name: '   ' } })).status, 400, 'a project needs a name');

    // Change some settings; the others stay.
    const patched = await backend.call('PATCH', `/v1/projects/${project.id}`, a, {
        body: { name: 'Bees', language: 'pl', lastUsedAt: 1_700_000_000_000 },
    });
    assertEq(patched.status, 200, 'changing settings');
    const listed = (await backend.call('GET', '/v1/projects', a)).body.projects as Project[];
    assertEq(listed.length, 1);
    assertEq(listed[0]?.name, 'Bees');
    assertEq(listed[0]?.language, 'pl');
    assertEq(listed[0]?.occasion, 'A PhD pre-defense', 'what was not changed stays');
    assertEq(listed[0]?.namesAndTerms, 'Varroa, Kyiv; Linden.\nTetiana Kovalenko');
    assertEq(listed[0]?.lastUsedAt ?? undefined, 1_700_000_000_000);

    // What the Mac app sends after an edit: all the fields, times with fractions of a millisecond.
    const full = await backend.call('PATCH', `/v1/projects/${project.id}`, a, {
        body: { name: 'Bees', occasion: '', language: 'pl', namesAndTerms: '', lastUsedAt: 1_700_000_001_234.567 },
    });
    assertEq(full.status, 200, 'a full update');
    assertEq(
        (await backend.call('PATCH', `/v1/projects/${project.id}`, a, { body: { createdAt: 1 } })).status,
        400,
        'a field that cannot be changed',
    );

    // Another person's view: nothing of Ann's, and her project's address finds nothing.
    assertEq((await backend.call('GET', '/v1/projects', b)).body.projects.length, 0, "Bob sees none of Ann's projects");
    await backend.call('POST', '/v1/projects', b, { body: { name: 'Bob only' } });
    assertDeepEq(
        ((await backend.call('GET', '/v1/projects', a)).body.projects as Project[]).map((item) => item.name),
        ['Bees'],
        "Ann sees none of Bob's",
    );
    for (const [method, path, body] of [
        ['GET', `/v1/projects/${project.id}`, undefined],
        ['PATCH', `/v1/projects/${project.id}`, { name: 'Mine now' }],
        ['GET', `/v1/projects/${project.id}/materials`, undefined],
        ['GET', `/v1/projects/${project.id}/prepared-answers`, undefined],
        ['DELETE', `/v1/projects/${project.id}`, undefined],
    ] as const) {
        const result = await backend.call(method, path, b, { body });
        assertEq(result.status, 404, `Bob's ${method} ${path}`);
        assertEq(result.body.error.code, 'not_found');
    }
    assertEq((await backend.call('GET', `/v1/projects/${project.id}`, a)).body.name, 'Bees', "Bob's attempts changed nothing");

    // Delete.
    assertEq((await backend.call('DELETE', `/v1/projects/${project.id}`, a)).status, 200);
    assertEq((await backend.call('GET', '/v1/projects', a)).body.projects.length, 0, 'the project is gone');
    assertEq((await backend.call('GET', '/v1/projects', b)).body.projects.length, 1, "and Bob's is not");
});
