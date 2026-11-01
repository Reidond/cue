import { env } from 'cloudflare:workers';
import { ApiError } from './errors.ts';
import { limitState } from './usage.ts';

// What stops a person using more than they may: a request rate (Cloudflare's Rate Limiting bindings, per user) and the month's allowance in
// dollars (the `usage` table against `user_limit` or the admin's default).

/** Every `/v1` request counts against `RATE_LIMIT`; a request that starts paid work also counts against the stricter `RATE_LIMIT_COSTLY`. */
export async function limitRate(userId: string, costly = false): Promise<void> {
    const { success } = await (costly ? env.RATE_LIMIT_COSTLY : env.RATE_LIMIT).limit({ key: userId });
    if (!success) throw new ApiError('rate_limited', 'Too many requests too quickly. Wait a moment and try again.', true);
}

/** Over this month's allowance: `limit_reached` (402), with the sentence the app shows as it is. */
export async function mustBeWithinLimit(userId: string): Promise<void> {
    const state = await limitState(env.DB, userId);
    if (state.over) throw new ApiError('limit_reached', state.message);
}

/** The gate of everything that costs money (a call, a question, a material): the stricter rate, then the allowance. */
export async function mayStartCostlyWork(userId: string): Promise<void> {
    await limitRate(userId, true);
    await mustBeWithinLimit(userId);
}
