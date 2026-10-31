import { ApiError as ApiErrorBody, PartQuery, RecordingPath, type Side, TakeQuery, Upload, UploadedPart } from '@cue/contract';
import { env } from 'cloudflare:workers';
import { Elysia } from 'elysia';
import { ApiError } from '../errors.ts';
import { authed } from './authed.ts';

const errors = { 400: ApiErrorBody, 401: ApiErrorBody, 404: ApiErrorBody };

interface UploadRow {
    upload_id: string;
    object_key: string;
    status: 'open' | 'done';
    size: number | null;
}

export const contentTypeOf = (side: Side) => (side === 'mixed' ? 'audio/mp4' : 'audio/wav');

/** Where a recording's side is kept in R2. */
export const recordingKey = (userId: string, callId: string, take: number, side: Side) =>
    `users/${userId}/calls/${callId}/${take}/${side}.${side === 'mixed' ? 'm4a' : 'wav'}`;

/** A call of this person, whether it is over or not; anyone else's is `not_found`. */
async function mustFindCall(userId: string, id: string): Promise<void> {
    const row = await env.DB.prepare('SELECT id FROM call WHERE id = ? AND user_id = ?').bind(id, userId).first();
    if (!row) throw new ApiError('not_found', 'That call does not exist.');
}

const find = (userId: string, callId: string, take: number, side: Side) =>
    env.DB.prepare('SELECT upload_id, object_key, status, size FROM upload WHERE user_id = ? AND call_id = ? AND take = ? AND side = ?')
        .bind(userId, callId, take, side)
        .first<UploadRow>();

async function stateOf(row: UploadRow, side: Side): Promise<Upload> {
    const { results } = await env.DB.prepare(
        'SELECT part_number AS partNumber, size FROM upload_part WHERE upload_id = ? ORDER BY part_number',
    )
        .bind(row.upload_id)
        .all<{ partNumber: number; size: number }>();
    return { uploadId: row.upload_id, side, status: row.status, parts: results, size: row.size };
}

/**
 * A recording's audio goes to R2 as a multipart upload through the Worker: `POST` begins it (or, again, says which parts already arrived: the resume
 * state, kept in D1 because the R2 binding cannot list parts), `PUT …?part=N` sends one part as the request body, `POST …/complete` finishes it. A
 * call can hold several recordings, told apart by `take`, the recording's start. Each part is under the Worker's 100 MB request limit.
 */
export const recordings = new Elysia({ name: 'recordings' })
    .use(authed)
    .post(
        '/calls/:id/recording/:side',
        async ({ userId, params, query }) => {
            await mustFindCall(userId, params.id);
            let row = await find(userId, params.id, query.take, params.side);
            if (!row) {
                const key = recordingKey(userId, params.id, query.take, params.side);
                const created = await env.RECORDINGS.createMultipartUpload(key, {
                    httpMetadata: { contentType: contentTypeOf(params.side) },
                });
                await env.DB.prepare(
                    'INSERT INTO upload (upload_id, user_id, call_id, take, side, object_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (call_id, take, side) DO NOTHING',
                )
                    .bind(created.uploadId, userId, params.id, query.take, params.side, key, Date.now())
                    .run();
                row = (await find(userId, params.id, query.take, params.side))!;
                // Two begins at once: the other's upload is the one that stays.
                if (row.upload_id !== created.uploadId) await created.abort().catch(() => {});
            }
            return stateOf(row, params.side);
        },
        {
            params: RecordingPath,
            query: TakeQuery,
            response: { 200: Upload, ...errors },
            detail: { summary: 'Begins the multipart upload of a recording’s side, or says which parts already arrived' },
        },
    )
    .put(
        '/calls/:id/recording/:side',
        async ({ userId, params, query, request }) => {
            await mustFindCall(userId, params.id);
            const row = await find(userId, params.id, query.take, params.side);
            if (!row) throw new ApiError('not_found', 'Begin the upload first.');
            if (row.status !== 'open') throw new ApiError('bad_request', 'That upload is already complete.');
            const size = Number(request.headers.get('content-length'));
            if (!Number.isInteger(size) || size <= 0 || !request.body) {
                throw new ApiError('bad_request', 'Send the part as the request body, with its Content-Length.');
            }
            // The part streams into R2; a connection that breaks partway records nothing, and the part is sent again.
            const part = await env.RECORDINGS.resumeMultipartUpload(row.object_key, row.upload_id).uploadPart(query.part, request.body);
            await env.DB.prepare('INSERT OR REPLACE INTO upload_part (upload_id, part_number, etag, size) VALUES (?, ?, ?, ?)')
                .bind(row.upload_id, query.part, part.etag, size)
                .run();
            return { partNumber: query.part, etag: part.etag };
        },
        {
            // The route reads its own body: Elysia would buffer it and the stream could not go to R2.
            parse: () => true,
            params: RecordingPath,
            query: PartQuery,
            response: { 200: UploadedPart, ...errors },
            detail: { summary: 'Uploads one part (the request body) of a recording’s side; parts of 5 MiB or more, except the last' },
        },
    )
    .post(
        '/calls/:id/recording/:side/complete',
        async ({ userId, params, query }) => {
            await mustFindCall(userId, params.id);
            const row = await find(userId, params.id, query.take, params.side);
            if (!row) throw new ApiError('not_found', 'Begin the upload first.');
            if (row.status === 'done') return stateOf(row, params.side);
            const { results } = await env.DB.prepare(
                'SELECT part_number AS partNumber, etag, size FROM upload_part WHERE upload_id = ? ORDER BY part_number',
            )
                .bind(row.upload_id)
                .all<{ partNumber: number; etag: string; size: number }>();
            if (results.length === 0) throw new ApiError('bad_request', 'No part of that recording has arrived.');
            let object: R2Object;
            try {
                object = await env.RECORDINGS.resumeMultipartUpload(row.object_key, row.upload_id).complete(
                    results.map(({ partNumber, etag }) => ({ partNumber, etag })),
                );
            } catch (error) {
                throw new ApiError(
                    'bad_request',
                    `The parts do not make a whole recording: ${error instanceof Error ? error.message : 'rejected'}`,
                );
            }
            await env.DB.prepare("UPDATE upload SET status = 'done', size = ? WHERE upload_id = ?").bind(object.size, row.upload_id).run();
            return stateOf({ ...row, status: 'done', size: object.size }, params.side);
        },
        {
            params: RecordingPath,
            query: TakeQuery,
            response: { 200: Upload, ...errors },
            detail: { summary: 'Finishes the upload of a recording’s side from the parts that arrived' },
        },
    );
