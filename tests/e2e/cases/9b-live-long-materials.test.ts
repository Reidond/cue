import { writeFileSync } from 'node:fs';
import { assertEq, e2eCase, fail, LiveClient, startCall } from '../harness/index.ts';

// Words that are no language's and say nothing, so that only the facts put among them match a question.
const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'ru', 'ta', 'vo', 'zi', 'pe', 'su', 'do', 'fa', 'gu', 'he', 'jo', 'xi'];
function filler(seed: number, words: number): string {
    let state = seed;
    const next = () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state;
    };
    const out: string[] = [];
    for (let index = 0; index < words; index++) {
        const length = 3 + (next() % 3);
        out.push(Array.from({ length }, () => SYLLABLES[next() % SYLLABLES.length]).join(''));
    }
    return `${out.join(' ')}.`;
}

/** A long file of sections of filler, with `facts` (heading → paragraph) among them. */
function longFile(seed: number, sections: number, facts: Record<string, string>): string {
    const parts: string[] = [];
    const placed = Object.entries(facts);
    for (let index = 0; index < sections; index++) {
        parts.push(`## Section ${seed}-${index}`, filler(seed * 1000 + index, 120), filler(seed * 1000 + index + 500, 120));
        const fact = placed[index % 7 === 3 ? Math.floor(index / 7) : -1];
        if (fact) parts.push(`## ${fact[0]}`, fact[1]);
    }
    return parts.join('\n\n');
}

e2eCase(
    'Materials too long for the prompt are found in passages: the system prompt lists the files, each question brings the passages that answer it (in another language too), and the conversation keeps only the questions.',
    async (cue) => {
        cue.standIns({
            FAKE_CLAUDE_ANSWER: 'Winter losses were 17 percent.\nSource: losses.md',
            // What a multilingual model knows: these Ukrainian words mean the English ones.
            FAKE_EMBEDDINGS_SYNONYMS: JSON.stringify({ спорожняв: 'emptied', пастки: 'traps', роїв: 'swarm' }),
        });
        // Four files of about 100,000 characters each: more than three times what goes whole into the prompt.
        const files = [
            cue.save('field.md', longFile(1, 50, {})),
            cue.save(
                'losses.md',
                longFile(2, 50, { 'Winter losses': 'The rooftop colonies lost 17 percent of their hives over the winter of 2025.' }),
            ),
            cue.save('traps.md', longFile(3, 50, { 'Swarm traps': 'Marta emptied the swarm traps every Thursday morning.' })),
            cue.save('notes.md', longFile(4, 50, {})),
        ];
        const backend = await cue.backend();
        const call = await startCall(backend, 'ann@cue.test', { materials: files, call: { auto: false } });
        const live = await LiveClient.connect(backend, call.token, call.callId);
        await live.next('status', (status) => status.part === 'claude' && status.state === 'ready', 30);

        // The cached system prompt names the files and their sections, not their 240,000 characters.
        const system = cue.claudeRequests('answer-system').at(-1) ?? fail('the answer prompt should be warmed');
        writeFileSync(cue.path('system.txt'), system);
        if (system.length > 20_000) fail(`the system prompt should list the materials, not hold them: ${system.length} characters`);
        for (const name of ['field.md', 'losses.md', 'traps.md', 'notes.md']) {
            if (!system.includes(`- ${name}`)) fail(`the system prompt should list ${name}`, system);
        }
        if (!system.includes('Excerpts from the materials')) fail('and say that each question brings its passages', system);
        if (system.includes('17 percent')) fail('no passage is in the system prompt', system);

        // The passages are made into vectors once, in batches.
        await cue.waitFor('the passages to be made into vectors', 30, () =>
            cue.serviceRequests('embeddings-request').some((request) => request.texts > 1),
        );

        // A question brings the passage that answers it, and not the rest.
        live.command({ type: 'ask', text: 'What were the winter losses on the rooftops?' });
        const first = await live.next('question', () => true, 10);
        await live.next('answer.done', (event) => event.questionId === first.id, 30);
        assertEq(live.answerTo(first.id), 'Winter losses were 17 percent.\nSource: losses.md');
        const asked = cue.claudeRequests('ask').at(-1) ?? fail('the question should reach Claude');
        writeFileSync(cue.path('ask-1.txt'), asked);
        if (!asked.includes('[losses.md › Winter losses]\n')) fail('the question should come with the passage under its label', asked);
        if (!asked.includes('17 percent of their hives')) fail('with the passage itself', asked);
        if (asked.length > 30_000) fail(`with no more than its passages: ${asked.length} characters`);

        // In Ukrainian, about an English file: no word is shared, the meaning finds it.
        live.command({ type: 'ask', text: 'Хто спорожняв пастки для роїв?' });
        const second = await live.next('question', (event) => event.id !== first.id, 10);
        await live.next('answer.done', (event) => event.questionId === second.id, 30);
        const translated = cue.claudeRequests('ask').at(-1) ?? fail('the second question should reach Claude');
        writeFileSync(cue.path('ask-2.txt'), translated);
        if (!translated.includes('Marta emptied the swarm traps'))
            fail('the Ukrainian question should bring the English passage', translated);

        // The conversation keeps the first question and its answer, not the passages it came with, and is cached up to them.
        const requests = cue.serviceRequests('anthropic-request').filter((request) => request.kind === 'answer' && request.maxTokens > 0);
        const latest = requests.at(-1) ?? fail('the second question should be noted');
        assertEq(latest.messages, 3, 'the first question, its answer and the second');
        if (latest.historyChars > 5_000) fail(`the conversation should not keep the passages: ${latest.historyChars} characters`);
        assertEq(JSON.stringify(latest.historyCache), JSON.stringify({ type: 'ephemeral', ttl: '1h' }), 'cached up to the last answer');
        assertEq(JSON.stringify(latest.cache), undefined, 'not with the passages that change every question');

        // What it cost: the passages and questions turned into vectors, in the usage table.
        await backend.call('POST', `/v1/calls/${call.callId}/end`, call.token);
        const rows = await backend.rows("SELECT provider, model, unit, units FROM usage WHERE feature = 'material_search'");
        const row = rows[0] ?? fail('the vectors should be recorded as usage', JSON.stringify(rows));
        assertEq([row['provider'], row['model'], row['unit']].map(String).join(' '), 'cloudflare workers-ai-bge-m3 input_tokens');
        if (Number(row['units']) < 60_000) fail('every passage counts', JSON.stringify(rows));
    },
);
