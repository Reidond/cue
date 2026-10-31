import { env } from 'cloudflare:workers';
import { ApiError } from '../errors.ts';

// Text out of PDF, Word, spreadsheets and the other formats Workers AI `toMarkdown` takes. In production that is `env.AI.toMarkdown`; it runs
// on Cloudflare even under `cf dev` and needs the account, so a case (and a developer without a token) leaves the `AI` binding out and sets
// MARKDOWN_URL: a stand-in (tests/e2e/harness/fake-providers.ts) that is sent the file and answers in the same shape.

/** What `toMarkdown` returns for each file. */
export interface MarkdownResult {
    name: string;
    format: 'markdown' | 'error';
    data: string;
    tokens?: number;
    error?: string;
}

export async function toMarkdown(name: string, bytes: ArrayBuffer, type: string): Promise<MarkdownResult> {
    // The type comes from `cf workers types` of the default config, which leaves the binding out.
    const ai = (env as { AI?: { toMarkdown(files: { name: string; blob: Blob }[]): Promise<MarkdownResult[]> } }).AI;
    if (ai) {
        const [result] = await ai.toMarkdown([{ name, blob: new Blob([bytes], { type }) }]);
        if (result) return result;
        throw new ApiError('upstream_unavailable', "Cue couldn't read that file just now. Try again.", true);
    }
    if (!env.MARKDOWN_URL) throw new ApiError('upstream_unavailable', "Cue can't read PDF and Word files just now. Try again later.", true);
    const response = await fetch(env.MARKDOWN_URL, {
        method: 'POST',
        headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) },
        body: bytes,
    }).catch(() => undefined);
    if (!response?.ok) throw new ApiError('upstream_unavailable', "Cue couldn't read that file just now. Try again.", true);
    return (await response.json()) as MarkdownResult;
}
