import { ANSWER_MODEL, JUDGE_MODEL, type Tokens, type UsageRow } from './call/models.ts';

// What everything the backend buys costs: the one table every `usage` row is priced by. Amounts are millionths of a US dollar (the unit of
// the `usage` table's `cost_micros`), prices are the providers' list prices as of November 2026 (platform.claude.com/docs/en/about-claude/pricing,
// deepgram.com/pricing): check them again whenever they change. A new model or provider is a new line here, nowhere else.

interface TokenPrices {
    /** Per million input tokens. */
    input: number;
    /** Per million output tokens. */
    output: number;
    /** Per million tokens written to the prompt cache, for an hour (src/call/session.ts caches for 1h). */
    cacheWrite: number;
    /** Per million tokens read from the prompt cache. */
    cacheRead: number;
}

export const PRICING = {
    models: {
        [ANSWER_MODEL]: { input: 2_000_000, output: 10_000_000, cacheWrite: 4_000_000, cacheRead: 100_000 },
        // Haiku's prices for prompts up to 100,000 tokens: the judge's are a few hundred.
        [JUDGE_MODEL]: { input: 100_000, output: 500_000, cacheWrite: 200_000, cacheRead: 10_000 },
    } satisfies Record<string, TokenPrices>,
    /**
     * Deepgram Nova-3 (one language), per minute of audio: streaming 0.0077 USD (both sides of a live call are billed), a recorded file 0.0043 USD.
     * Speakers (`diarize`, the call side's) cost 0.0020 USD more on a stream and nothing more on a file; keyterms (a project's names and terms)
     * 0.0013 USD more on either.
     */
    deepgram: {
        live: { base: 7_700, diarize: 2_000, keyterms: 1_300 },
        recorded: { base: 4_300, diarize: 0, keyterms: 1_300 },
    },
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

/** What Deepgram was asked for besides the words: speakers, and keyterms to listen for. */
export interface SpeechAddOns {
    diarize: boolean;
    keyterms: boolean;
}

/** What `seconds` of audio cost Deepgram: live (a stream per side) or a recorded file, with the add-ons it was asked for. */
export const speechMicros = (kind: 'live' | 'recorded', seconds: number, addOns: SpeechAddOns) => {
    const price = PRICING.deepgram[kind];
    const perMinute = price.base + (addOns.diarize ? price.diarize : 0) + (addOns.keyterms ? price.keyterms : 0);
    return Math.round((seconds * perMinute) / 60);
};

/** The `usage` row of Deepgram having heard `seconds` of audio. */
export const speechUsage = (feature: string, kind: 'live' | 'recorded', model: string, seconds: number, addOns: SpeechAddOns): UsageRow => [
    feature,
    'deepgram',
    model,
    Math.round(seconds * 1000) / 1000,
    'audio_seconds',
    speechMicros(kind, seconds, addOns),
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
