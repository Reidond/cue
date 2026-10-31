import { ApiError as ApiErrorBody, Call, CallEnded, CallId, LiveQuery, NewCall, AskBody } from '@cue/contract';
import { Value } from '@sinclair/typebox/value';
import { env } from 'cloudflare:workers';
import { Elysia } from 'elysia';
import { callOf } from '../call/stub.ts';
import { authFor } from '../context.ts';
import { ApiError } from '../errors.ts';
import { findProject } from '../projects.ts';
import { planPaused } from '../settings.ts';
import { authenticate } from '../token.ts';
import { authed } from './authed.ts';

const errors = { 401: ApiErrorBody, 404: ApiErrorBody };

/** A call of this person that has not ended; anyone else's is `not_found`. */
async function mustFind(userId: string, id: string): Promise<{ project_id: string | null }> {
    const row = await env.DB.prepare('SELECT project_id FROM call WHERE id = ? AND user_id = ? AND ended_at IS NULL')
        .bind(id, userId)
        .first<{ project_id: string | null }>();
    if (!row) throw new ApiError('not_found', 'That call does not exist, or it is over.');
    return row;
}

/**
 * The live socket. It is mounted rather than a typed route because Elysia rebuilds every `Response` a route returns, and under `cf dev` that drops
 * the Durable Object's `webSocket` (the 101 reaches the client as a hang-up); `.mount` hands the request over and returns what the Durable Object
 * answers untouched. A mounted handler runs before Elysia's hooks in that mode, so it asks for the bearer token and the plan itself.
 */
async function live(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') throw new ApiError('bad_request', 'This is a WebSocket: connect with an upgrade.');
    const { userId } = await authenticate(request, authFor, env.PUBLIC_URL, env.DENYLIST);
    if (await planPaused(env.DB)) throw new ApiError('plan_paused', 'Cue is paused for now. Try again later.', true);
    const params = new URL(request.url).searchParams;
    const query = { call: params.get('call') ?? '', ...(params.has('after') ? { after: Number(params.get('after')) } : {}) };
    if (!Value.Check(LiveQuery, query)) throw new ApiError('bad_request', 'Say which call: ?call=ID[&after=SEQ].');
    await mustFind(userId, query.call);
    return callOf(query.call).fetch(request);
}

/** Live calls: `POST /v1/calls` starts one (a Call Durable Object), `…/questions` is the Ask field, `…/end` ends it; `GET /v1/live` is its WebSocket. */
export const calls = new Elysia({ name: 'calls', prefix: '/calls' })
    .use(authed)
    .post(
        '/',
        async ({ userId, body, status }) => {
            const project = await findProject(env.DB, userId, body.projectId);
            if (!project) throw new ApiError('not_found', 'That project does not exist.');
            const callId = crypto.randomUUID();
            const startedAt = Date.now();
            await env.DB.prepare('INSERT INTO call (id, user_id, project_id, event_id, event_title, started_at) VALUES (?, ?, ?, ?, ?, ?)')
                .bind(callId, userId, project.id, body.eventId ?? null, body.eventTitle ?? null, startedAt)
                .run();
            await callOf(callId).begin({
                callId,
                userId,
                projectId: project.id,
                startedAt,
                speaker: body.speaker ?? '',
                auto: body.auto ?? true,
                micQuestions: body.micQuestions ?? false,
                questions: body.questions ?? true,
            });
            return status(201, { callId, projectId: project.id, startedAt });
        },
        { body: NewCall, response: { 201: Call, 400: ApiErrorBody, 401: ApiErrorBody, 404: ApiErrorBody }, detail: { summary: 'Starts a live call for a project' } },
    )
    .post(
        '/:id/questions',
        async ({ userId, params, body }) => {
            await mustFind(userId, params.id);
            const events = await callOf(params.id).ask(body.text);
            return new Response(events, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
        },
        { params: CallId, body: AskBody, response: { 401: ApiErrorBody, 404: ApiErrorBody }, detail: { summary: 'The Ask field: answers a question now (server-sent events: question, prepared, answer.delta, answer.done)' } },
    )
    .post(
        '/:id/end',
        async ({ userId, params }) => {
            await mustFind(userId, params.id);
            const { lines } = await callOf(params.id).end();
            return { callId: params.id, lines };
        },
        { params: CallId, response: { 200: CallEnded, ...errors }, detail: { summary: 'Ends a call: the speech streams finish, usage is recorded, the transcript is kept' } },
    );

/** `GET /v1/live?call=ID[&after=SEQ]`: the call's WebSocket (see `live`). */
export const liveSocket = new Elysia({ name: 'live' }).mount('/v1/live', live);
