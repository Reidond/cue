import { ApiError as ApiErrorBody, SummaryBody } from '@cue/contract';
import { env } from 'cloudflare:workers';
import { Elysia } from 'elysia';
import { describe, stream } from '../call/anthropic.ts';
import { ANSWER_MODEL, tokenUsage } from '../call/models.ts';
import { recordUsage } from '../usage.ts';
import { authed } from './authed.ts';

/**
 * A call's summary, written by Claude from the system prompt and transcript the client sends. Temporary: until PR 6's notes Workflow builds
 * the notes on the server, the Mac app still writes them itself, but with the plan's key, which stays here.
 */
export const summaries = new Elysia({ name: 'summaries', prefix: '/summaries' }).use(authed).post(
    '/',
    ({ userId, body, request }) => {
        const encoder = new TextEncoder();
        const body_ = new ReadableStream<Uint8Array>({
            async start(controller) {
                const event = (name: string, data: object) => controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
                try {
                    // Claude may think first (the default): nobody waits on the first word here.
                    const result = await stream(
                        { model: ANSWER_MODEL, max_tokens: 16000, system: body.system, messages: [{ role: 'user', content: `Transcript:\n\n${body.transcript}` }] },
                        (text) => event('delta', { text }),
                        request.signal,
                    );
                    await recordUsage(env.DB, userId, tokenUsage('call_summary', ANSWER_MODEL, result.tokens));
                    event('done', {});
                } catch (error) {
                    event('error', { message: describe(error) });
                } finally {
                    controller.close();
                }
            },
        });
        return new Response(body_, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' } });
    },
    { body: SummaryBody, response: { 401: ApiErrorBody }, detail: { summary: 'Writes a summary (server-sent events: delta, done, error)' } },
);
