import { env } from 'cloudflare:workers';
import type { Call } from './call.ts';

/**
 * The Durable Object of a call, by its id, typed with `Call`'s RPC methods. The binding in cloudflare.config.ts names its own Worker, which
 * the generated types cannot follow (a Worker cannot refer to its own config), so the namespace is typed here.
 */
export const callOf = (id: string) => (env.CALL as DurableObjectNamespace<Call>).getByName(id);
