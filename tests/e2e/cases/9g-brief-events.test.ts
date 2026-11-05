import { assertBetween, assertDeepEq, assertEq, e2eCase, fixture, type ServerSentEvent, sleep, writeFile } from '../harness/index.ts';

const BRIEF = { occasion: 'A talk on rooftop bees.', namesAndTerms: ['linden'], answers: [] };

interface Brief {
    state: string;
    error: string | null;
    occasion: string;
    updatedAt: number | null;
}

const briefsIn = (events: ServerSentEvent[]) => events.filter((event) => event.event === 'brief').map((event) => event.data as Brief);
const statesIn = (events: ServerSentEvent[]) => briefsIn(events).map((brief) => brief.state);

e2eCase(
    "A project's brief is followed over server-sent events: its state at once, then each change while Cue writes it (the connection kept open " +
        "while Claude takes its time), the stream ending with the brief written, failed or gone; another person's project is not found.",
    async (cue) => {
        // Claude takes 17 s: longer than the 15 s between beats.
        cue.standIns({ FAKE_CLAUDE_BRIEF: JSON.stringify(BRIEF), FAKE_CLAUDE_BRIEF_DELAY: '17' });
        const backend = await cue.backend();
        const email = 'ann@cue.test';
        await backend.invite(email);
        const account = await backend.accountOf(email);
        const token = account.token;
        const created = (await backend.call('POST', '/v1/projects', token, { body: { name: 'Bee talk' } })).body as { id: string };
        const base = `/v1/projects/${created.id}`;
        const upload = async (path: string) => {
            const added = await backend.call('POST', `${base}/materials`, token, { file: { path } });
            assertEq(added.status, 201, JSON.stringify(added.body));
            return (added.body as { id: string }).id;
        };

        // Followed from the file's arrival: working at once, then ready as soon as it is written, and the stream ends.
        const talk = await upload(fixture('materials', 'talk.md'));
        const opened = Date.now();
        const events = await account.briefEvents(created);
        assertDeepEq(statesIn(events), ['working', 'ready'], `one event per change: ${JSON.stringify(events)}`);
        assertBetween(events[0]!.at - opened, 0, 2000, `the state comes at once, not after ${events[0]!.at - opened} ms`);
        assertEq(
            events.some((event) => event.event === 'ping'),
            true,
            `a beat kept the connection open while Claude wrote: ${JSON.stringify(events)}`,
        );
        const last = events.at(-1)!;
        assertEq(last.event, 'brief', 'the stream ends with the brief');
        const written = (await account.project('Bee talk')).brief;
        const sent = last.data as Brief;
        assertDeepEq(
            [sent.state, sent.occasion, sent.updatedAt],
            [written.state, written.occasion, written.updatedAt],
            'the brief as the project has it',
        );
        assertEq(written.occasion, BRIEF.occasion);
        const late = last.at - written.updatedAt!;
        assertBetween(late, 0, 2000, `it came as soon as it was written, not ${late} ms later`);
        assertEq(cue.claudeRequests('brief-input').length, 1);

        // Opened once it is written: the brief, and the end.
        assertDeepEq(statesIn(await account.briefEvents(created)), ['ready']);

        // Claude fails every time (each try of the step): the stream ends with why.
        cue.standIns({ FAKE_CLAUDE_BRIEF: JSON.stringify(BRIEF), FAKE_ANTHROPIC_BRIEF_FAILS: '1000' });
        const notes = await upload(writeFile(cue.path('files', 'notes.md'), 'A hive gives 20 kg of honey.\n'));
        const failed = briefsIn(await account.briefEvents(created));
        assertDeepEq(
            failed.map((brief) => brief.state),
            ['working', 'failed'],
        );
        assertEq(failed.at(-1)!.error ?? undefined, 'Claude: The brief failed', 'why, for people');
        assertEq(failed.at(-1)!.occasion, BRIEF.occasion, 'the brief before is kept');

        // The files go while Claude reads them: the brief is gone, and so is the stream.
        cue.standIns({ FAKE_CLAUDE_BRIEF: JSON.stringify(BRIEF), FAKE_CLAUDE_BRIEF_DELAY: '30' });
        assertEq((await backend.call('DELETE', `${base}/materials/${notes}`, token)).status, 200);
        const following = account.briefEvents(created);
        await sleep(1);
        assertEq((await backend.call('DELETE', `${base}/materials/${talk}`, token)).status, 200);
        assertDeepEq(statesIn(await following), ['working', 'none'], 'no files, no brief');

        // The project goes while its brief is written: the stream ends.
        await upload(fixture('materials', 'talk.md'));
        const deleting = account.briefEvents(created);
        await sleep(1);
        assertEq((await backend.call('DELETE', base, token)).status, 200);
        const ended = Date.now();
        assertDeepEq(statesIn(await deleting), ['working']);
        assertBetween(Date.now() - ended, 0, 2000, `at once, not after ${Date.now() - ended} ms`);

        // Another person's project, or none at all, is not found.
        await backend.invite('bob@cue.test');
        const bob = await backend.accountOf('bob@cue.test');
        const theirs = (await backend.call('POST', '/v1/projects', token, { body: { name: 'Ann’s' } })).body as { id: string };
        for (const id of [theirs.id, 'nothing']) {
            const refused = await backend.call('GET', `/v1/projects/${id}/brief/events`, bob.token);
            assertEq(refused.status, 404, JSON.stringify(refused.body));
            assertEq(refused.body.error.code, 'not_found');
        }
    },
);
