import {
    ApiError as ApiErrorBody,
    Deleted,
    MATERIAL_EXTENSIONS,
    MATERIAL_MAX_BYTES,
    Material,
    MaterialPath,
    MaterialText,
    Materials,
    ProjectId,
    UploadQuery,
} from '@cue/contract';
import { env } from 'cloudflare:workers';
import { Elysia } from 'elysia';
import { ApiError } from '../errors.ts';
import { extensionOf, extract, isSupported, preparedIn, summaryOf } from '../materials/read.ts';
import { findProject, type ProjectRow, projectPrefix } from '../projects.ts';
import { TOMARKDOWN_MICROS_PER_FILE } from '../usage.ts';
import { authed } from './authed.ts';

interface MaterialRow {
    id: string;
    name: string;
    content_type: string;
    size: number;
    etag: string;
    r2_key: string;
    error: string | null;
    text: string;
    qa: string | null;
    words: number;
    slides: number | null;
    created_at: number;
}

const COLUMNS = 'id, name, content_type, size, etag, r2_key, error, text, qa, words, slides, created_at';
const errors = { 401: ApiErrorBody, 404: ApiErrorBody };

async function mustFindProject(userId: string, id: string): Promise<ProjectRow> {
    const row = await findProject(env.DB, userId, id);
    if (!row) throw new ApiError('not_found', 'That project does not exist.');
    return row;
}

/** A material as the API says it; the prepared answers depend on the project's language. */
function materialOf(row: MaterialRow, language: string): Material {
    const prepared = row.error === null ? preparedIn(row, language).length : 0;
    return {
        id: row.id,
        name: row.name,
        contentType: row.content_type,
        size: row.size,
        createdAt: row.created_at,
        error: row.error,
        summary: row.error === null ? summaryOf(row, prepared) : '',
        preparedCount: prepared,
    };
}

/** `talk.md`, then `talk 2.md`, `talk 3.md`: the first name nobody in the project has. */
function freeName(name: string, taken: Set<string>): string {
    if (!taken.has(name)) return name;
    const dot = name.lastIndexOf('.');
    const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    for (let number = 2; ; number++) if (!taken.has(`${stem} ${number}${extension}`)) return `${stem} ${number}${extension}`;
}

const FORMATS = [...MATERIAL_EXTENSIONS.text, ...MATERIAL_EXTENSIONS.slides, ...MATERIAL_EXTENSIONS.documents].join(', ');

/** The files in a project: uploaded to R2 as they arrive, read on the server (docs/backend.md › Materials). */
export const materials = new Elysia({ name: 'materials' })
    .use(authed)
    .post(
        '/projects/:id/materials',
        async ({ userId, params, query, request, status }) => {
            const project = await mustFindProject(userId, params.id);
            const name = query.name.split(/[/\\]/).at(-1)!.trim();
            if (name === '' || !isSupported(name)) {
                throw new ApiError('bad_request', `Cue can't read ${extensionOf(name) ? `.${extensionOf(name)}` : 'that kind of'} files. It takes ${FORMATS}.`);
            }
            const size = Number(request.headers.get('content-length'));
            if (!Number.isInteger(size) || size <= 0) throw new ApiError('bad_request', 'Send the file as the request body, with its Content-Length.');
            if (size > MATERIAL_MAX_BYTES) throw new ApiError('bad_request', `That file is over ${MATERIAL_MAX_BYTES / 1024 / 1024} MB.`);
            if (!request.body) throw new ApiError('bad_request', 'Send the file as the request body.');

            // The body goes straight to R2 as a stream (`parse: () => true` keeps Elysia from reading it first).
            const id = crypto.randomUUID();
            const key = `${projectPrefix(userId, params.id)}materials/${id}`;
            const contentType = request.headers.get('content-type') ?? 'application/octet-stream';
            const stored = await env.MATERIALS.put(key, request.body, { httpMetadata: { contentType } });

            const { results: others } = await env.DB.prepare(`SELECT ${COLUMNS} FROM material WHERE project_id = ? AND user_id = ?`)
                .bind(params.id, userId)
                .all<MaterialRow>();
            // The same file again is the same material.
            const same = others.find((other) => other.name === name && other.etag === stored.etag);
            if (same) {
                await env.MATERIALS.delete(key);
                return status(200, materialOf(same, project.language));
            }

            let read: Awaited<ReturnType<typeof extract>> | undefined;
            let error: string | null = null;
            try {
                const file = await env.MATERIALS.get(key);
                read = await extract(name, await file!.arrayBuffer(), contentType);
            } catch (caught) {
                if (caught instanceof ApiError) {
                    await env.MATERIALS.delete(key);
                    throw caught;
                }
                error = caught instanceof Error && !(caught instanceof TypeError) ? caught.message : 'Cue could not read this file.';
            }

            const row: MaterialRow = {
                id,
                name: freeName(name, new Set(others.map((other) => other.name))),
                content_type: contentType,
                size,
                etag: stored.etag,
                r2_key: key,
                error,
                text: read?.text ?? '',
                qa: read?.qa ? JSON.stringify(read.qa) : null,
                words: read?.words ?? 0,
                slides: read?.slides ?? null,
                created_at: Date.now(),
            };
            const statements = [
                env.DB.prepare(
                    `INSERT INTO material (id, project_id, user_id, ${COLUMNS.replace('id, ', '')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                ).bind(
                    row.id, params.id, userId, row.name, row.content_type, row.size, row.etag, row.r2_key, row.error, row.text, row.qa, row.words, row.slides, row.created_at,
                ),
            ];
            // Workers AI read it: one file of usage, priced by the table (PDFs and Office files are free, images are not).
            if (read?.markdown) {
                statements.push(
                    env.DB.prepare(
                        `INSERT INTO usage (user_id, feature, provider, model, units, unit, cost_micros) VALUES (?, 'material_text', 'cloudflare', 'workers-ai-tomarkdown', 1, 'files', ?)`,
                    ).bind(userId, TOMARKDOWN_MICROS_PER_FILE),
                );
            }
            await env.DB.batch(statements);
            return status(201, materialOf(row, project.language));
        },
        {
            // The route reads its own body: Elysia would buffer it and the stream could not go to R2.
            parse: () => true,
            params: ProjectId,
            query: UploadQuery,
            response: { 200: Material, 201: Material, 400: ApiErrorBody, ...errors, 502: ApiErrorBody },
            detail: { summary: "Adds a file to a project: the body is the file, its type the Content-Type, ?name= its name" },
        },
    )
    .get(
        '/projects/:id/materials',
        async ({ userId, params }) => {
            const project = await mustFindProject(userId, params.id);
            const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM material WHERE project_id = ? AND user_id = ?`)
                .bind(params.id, userId)
                .all<MaterialRow>();
            const sorted = results.toSorted((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
            return { materials: sorted.map((row) => materialOf(row, project.language)) };
        },
        { params: ProjectId, response: { 200: Materials, ...errors }, detail: { summary: "A project's materials, by name" } },
    )
    .get(
        '/projects/:id/materials/:materialId',
        async ({ userId, params }) => {
            const project = await mustFindProject(userId, params.id);
            const row = await env.DB.prepare(`SELECT ${COLUMNS} FROM material WHERE id = ? AND project_id = ? AND user_id = ?`)
                .bind(params.materialId, params.id, userId)
                .first<MaterialRow>();
            if (!row) throw new ApiError('not_found', 'That file does not exist.');
            return { ...materialOf(row, project.language), text: row.text };
        },
        { params: MaterialPath, response: { 200: MaterialText, ...errors }, detail: { summary: 'One material with the text the server read from it' } },
    )
    .delete(
        '/projects/:id/materials/:materialId',
        async ({ userId, params }) => {
            await mustFindProject(userId, params.id);
            const row = await env.DB.prepare('SELECT r2_key FROM material WHERE id = ? AND project_id = ? AND user_id = ?')
                .bind(params.materialId, params.id, userId)
                .first<{ r2_key: string }>();
            if (!row) throw new ApiError('not_found', 'That file does not exist.');
            await env.MATERIALS.delete(row.r2_key);
            await env.DB.prepare('DELETE FROM material WHERE id = ?').bind(params.materialId).run();
            return { deleted: params.materialId };
        },
        { params: MaterialPath, response: { 200: Deleted, ...errors }, detail: { summary: 'Removes a file from a project' } },
    );
