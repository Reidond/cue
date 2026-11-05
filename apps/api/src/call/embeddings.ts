import { env } from 'cloudflare:workers';

// Vectors of meaning for texts, so that the passages of long materials can be found by what a question means, in any language (excerpts.ts).
// In production that is Workers AI's multilingual `bge-m3`; like `toMarkdown` it needs the account even under `cf dev`, so there the `AI` binding is
// left out and EMBEDDINGS_URL is a stand-in (tests/e2e/harness/fake-providers.ts) that answers in the same shape. With neither, there are no vectors.

export const EMBEDDING_MODEL = '@cf/baai/bge-m3';

/** One vector per text, or null when there is no model to ask. Throws when the model fails. */
export async function embed(texts: string[]): Promise<number[][] | null> {
    // The type comes from `cf workers types` of the default config, which leaves the binding out.
    const ai = (env as { AI?: { run(model: string, input: { text: string[] }): Promise<{ data?: number[][] }> } }).AI;
    let data: number[][] | undefined;
    if (ai) {
        data = (await ai.run(EMBEDDING_MODEL, { text: texts })).data;
    } else if (env.EMBEDDINGS_URL) {
        const response = await fetch(env.EMBEDDINGS_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: texts }),
        });
        if (!response.ok) throw new Error(`The embeddings answered ${response.status}`);
        data = ((await response.json()) as { data?: number[][] }).data;
    } else {
        return null;
    }
    if (data?.length !== texts.length) throw new Error('The embeddings came back in the wrong shape');
    return data;
}
