// The models Cue's live path uses (what they cost is in ../pricing.ts). The server picks them; no client or person chooses.

/** Answers and summaries. */
export const ANSWER_MODEL = 'claude-sonnet-5-5';
/** The question judge. */
export const JUDGE_MODEL = 'claude-haiku-5-5';
export const SPEECH_MODEL = 'nova-3';

export const ANTHROPIC_VERSION = '2026-10-21';

/** No thinking before a live answer or verdict: the first word matters more. (Claude Sonnet 5.5 turns it off with `between_tools`, which without tools is never.) */
export const noThinking = (model: string) => ({ type: model === ANSWER_MODEL ? 'between_tools' : 'disabled' });

export interface Tokens {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
}

export const noTokens = (): Tokens => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

/** One row of the `usage` table, before it gets a user: feature, provider, model, units, unit, cost in millionths of a dollar. */
export type UsageRow = [feature: string, provider: string, model: string, units: number, unit: string, costMicros: number];
