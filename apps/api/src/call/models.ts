// The models Cue's live path uses, and what they cost. The server picks them; no client or person chooses.

/** Answers and summaries. */
export const ANSWER_MODEL = 'claude-sonnet-5-5';
/** The question judge. */
export const JUDGE_MODEL = 'claude-haiku-5-5';
export const SPEECH_MODEL = 'nova-3';

export const ANTHROPIC_VERSION = '2026-10-21';

/** No thinking before a live answer or verdict: the first word matters more. (Claude Sonnet 5.5 turns it off with `between_tools`, which without tools is never.) */
export const noThinking = (model: string) => ({ type: model === ANSWER_MODEL ? 'between_tools' : 'disabled' });

/** Millionths of a US dollar per million tokens. Priced from the providers' list prices; check them before the first deploy and whenever they change. */
const PRICES: Record<string, { input: number; output: number; cacheWrite: number; cacheRead: number }> = {
    [ANSWER_MODEL]: { input: 3_000_000, output: 15_000_000, cacheWrite: 6_000_000, cacheRead: 300_000 },
    [JUDGE_MODEL]: { input: 1_000_000, output: 5_000_000, cacheWrite: 2_000_000, cacheRead: 100_000 },
};

/** Deepgram Nova-3 streaming, per second of audio: 0.0077 USD a minute. */
export const SPEECH_MICROS_PER_SECOND = 128;

/** Deepgram Nova-3 on a recorded file, per second of audio: 0.0043 USD a minute. */
export const FILE_SPEECH_MICROS_PER_SECOND = 72;

/** What the tokens of one model cost, in millionths of a dollar. */
export function tokenCostMicros(model: string, tokens: Tokens): { input: number; output: number; cacheWrite: number; cacheRead: number } {
    const price = PRICES[model] ?? PRICES[ANSWER_MODEL]!;
    const cost = (count: number, perMillion: number) => Math.round((count * perMillion) / 1_000_000);
    return {
        input: cost(tokens.input, price.input),
        output: cost(tokens.output, price.output),
        cacheWrite: cost(tokens.cacheWrite, price.cacheWrite),
        cacheRead: cost(tokens.cacheRead, price.cacheRead),
    };
}

export interface Tokens {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
}

export const noTokens = (): Tokens => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

/** One row of the `usage` table, before it gets a user: feature, provider, model, units, unit, cost in millionths of a dollar. */
export type UsageRow = [feature: string, provider: string, model: string, units: number, unit: string, costMicros: number];

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
