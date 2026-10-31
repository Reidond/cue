import { env } from 'cloudflare:workers';
import { Elysia } from 'elysia';
import { ApiError } from '../errors.ts';
import { planPaused } from '../settings.ts';
import { materials } from './materials.ts';
import { me } from './me.ts';
import { projects } from './projects.ts';

/** Everything under `/v1`: the owner can pause the whole plan (admin › Settings), and then each of these routes answers `plan_paused`. */
export const v1 = new Elysia({ name: 'v1', prefix: '/v1' })
    .onBeforeHandle(async () => {
        if (await planPaused(env.DB)) throw new ApiError('plan_paused', 'Cue is paused for now. Try again later.', true);
    })
    .use(me)
    .use(projects)
    .use(materials);
