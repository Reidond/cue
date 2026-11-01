import { env } from 'cloudflare:workers';
import { createAuth } from './auth.ts';

// Built per request from `env`: bindings only exist per isolate, and nothing is kept between requests.
export const authFor = () => createAuth(env, env.DB);
