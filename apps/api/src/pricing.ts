import { ANSWER_MODEL, JUDGE_MODEL, type Tokens, type UsageRow } from './call/models.ts';

// What everything the backend buys costs: the one table every `usage` row is priced by. Amounts are millionths of a US dollar (the unit of
// the `usage` table's `cost_micros`), prices are the providers' list prices: check them against the providers' pages before the first
// deploy and whenever they change. A new model or provider is a new line here, nowhere else.

interface TokenPrices {
    /** Per million input tokens. */
    input: number;
    /** Per million output tokens. */
    output: number;
    /** Per million tokens written to the prompt cache. */
    cacheWrite: number;
    /** Per million tokens read from the prompt cache. */
    cacheRead: number;
}

export const PRICING = {
    models: {
        [ANSWER_MODEL]: { input: 3_000_000, output: 15_000_000, cacheWrite: 6_000_000, cacheRead: 300_000 },
        [JUDGE_MODEL]: { input: 1_000_000, output: 5_000_000, cacheWrite: 2_000_000, cacheRead: 100_000 },
    } satisfies Record<string, TokenPrices>,
    /** Deepgram Nova-3, per minute of audio: streaming 0.0077 USD (both sides of a live call are billed), a recorded file 0.0043 USD. */
    deepgram: { liveMicrosPerMinute: 7_700, recordedMicrosPerMinute: 4_300 },
    /** Workers AI `toMarkdown`, per file: PDFs and Office files are free (images are not, and are not accepted). */
    toMarkdown: { microsPerFile: 0 },
} as const;

/** What the tokens of one model cost; a model the table does not list is priced as the answer model (dearer, never free). */
export function tokenCostMicros(model: string, tokens: Tokens): TokenPrices {
    const price: TokenPrices = (PRICING.models as Record<string, TokenPrices>)[model] ?? PRICING.models[ANSWER_MODEL];
    const cost = (count: number, perMillion: number) => Math.round((count * perMillion) / 1_000_000);
    return {
        input: cost(tokens.input, price.input),
        output: cost(tokens.output, price.output),
        cacheWrite: cost(tokens.cacheWrite, price.cacheWrite),
        cacheRead: cost(tokens.cacheRead, price.cacheRead),
    };
}

/** The rows for the tokens one model used on one feature (the ones with nothing in them are left out). */
export function tokenUsage(feature: string, model: string, tokens: Tokens): UsageRow[] {
    const cost = tokenCostMicros(model, tokens);
    const rows: UsageRow[] = [
        [feature, 'anthropic', model, tokens.input, 'input_tokens', cost.input],
        [feature, 'anthropic', model, tokens.output, 'output_tokens', cost.output],
        [feature, 'anthropic', model, tokens.cacheWrite, 'cache_write_tokens', cost.cacheWrite],
        [feature, 'anthropic', model, tokens.cacheRead, 'cache_read_tokens', cost.cacheRead],
    ];
    return rows.filter((row) => row[3] > 0);
}

/** What `seconds` of audio cost Deepgram: live (a stream per side) or a recorded file. */
export const speechMicros = (kind: 'live' | 'recorded', seconds: number) =>
    Math.round((seconds * PRICING.deepgram[kind === 'live' ? 'liveMicrosPerMinute' : 'recordedMicrosPerMinute']) / 60);

/** The `usage` row of Deepgram having heard `seconds` of audio. */
export const speechUsage = (feature: string, kind: 'live' | 'recorded', model: string, seconds: number): UsageRow => [
    feature,
    'deepgram',
    model,
    Math.round(seconds * 1000) / 1000,
    'audio_seconds',
    speechMicros(kind, seconds),
];

/** The `usage` row of one file read with Workers AI `toMarkdown`. */
export const markdownUsage = (): UsageRow => [
    'material_text',
    'cloudflare',
    'workers-ai-tomarkdown',
    1,
    'files',
    PRICING.toMarkdown.microsPerFile,
];
