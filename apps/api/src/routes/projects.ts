import { ApiError as ApiErrorBody, Deleted, NewProject, PreparedAnswers, Project, ProjectId, ProjectPatch, Projects } from '@cue/contract';
import { env } from 'cloudflare:workers';
import { Elysia } from 'elysia';
import { ApiError } from '../errors.ts';
import { preparedIn } from '../materials/read.ts';
import { findProject, PROJECT_COLUMNS, type ProjectRow, projectOf, projectPrefix } from '../projects.ts';
import { authed } from './authed.ts';

const errors = { 401: ApiErrorBody, 404: ApiErrorBody };

async function mustFind(userId: string, id: string): Promise<ProjectRow> {
    const row = await findProject(env.DB, userId, id);
    if (!row) throw new ApiError('not_found', 'That project does not exist.');
    return row;
}

const cleanName = (name: string) => {
    const trimmed = name.trim();
    if (trimmed === '') throw new ApiError('bad_request', 'A project needs a name.');
    return trimmed;
};

/** A person's projects and every setting of one: its name, the occasion, the spoken language and the names and terms to listen for. */
export const projects = new Elysia({ name: 'projects', prefix: '/projects' })
    .use(authed)
    .get(
        '/',
        async ({ userId }) => {
            const { results } = await env.DB.prepare(
                `SELECT ${PROJECT_COLUMNS} FROM project p WHERE p.user_id = ? ORDER BY p.created_at, p.id`,
            )
                .bind(userId)
                .all<ProjectRow>();
            return { projects: results.map(projectOf) };
        },
        { response: { 200: Projects, 401: ApiErrorBody }, detail: { summary: "The signed-in person's projects" } },
    )
    .post(
        '/',
        async ({ userId, body, status }) => {
            const id = crypto.randomUUID();
            const createdAt = body.createdAt ?? Date.now();
            await env.DB.prepare(
                `INSERT INTO project (id, user_id, name, occasion, language, names_and_terms, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
                .bind(
                    id,
                    userId,
                    cleanName(body.name),
                    body.occasion ?? '',
                    body.language ?? 'en',
                    body.namesAndTerms ?? '',
                    createdAt,
                    body.lastUsedAt ?? null,
                )
                .run();
            return status(201, projectOf(await mustFind(userId, id)));
        },
        {
            body: NewProject,
            response: { 201: Project, 400: ApiErrorBody, 401: ApiErrorBody },
            detail: { summary: 'Creates a project (createdAt and lastUsedAt are for projects moved in from a client)' },
        },
    )
    .get('/:id', async ({ userId, params }) => projectOf(await mustFind(userId, params.id)), {
        params: ProjectId,
        response: { 200: Project, ...errors },
        detail: { summary: 'One project' },
    })
    .patch(
        '/:id',
        async ({ userId, params, body }) => {
            await mustFind(userId, params.id);
            const columns: Record<string, string | number | null | undefined> = {
                name: body.name === undefined ? undefined : cleanName(body.name),
                occasion: body.occasion,
                language: body.language,
                names_and_terms: body.namesAndTerms,
                last_used_at: body.lastUsedAt,
            };
            const changed = Object.entries(columns).filter(([, value]) => value !== undefined);
            if (changed.length > 0) {
                await env.DB.prepare(
                    `UPDATE project SET ${changed.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ? AND user_id = ?`,
                )
                    .bind(...changed.map(([, value]) => value as string | number | null), params.id, userId)
                    .run();
            }
            return projectOf(await mustFind(userId, params.id));
        },
        {
            params: ProjectId,
            body: ProjectPatch,
            response: { 200: Project, 400: ApiErrorBody, ...errors },
            detail: { summary: "Changes a project's settings" },
        },
    )
    .delete(
        '/:id',
        async ({ userId, params }) => {
            await mustFind(userId, params.id);
            // The files go with it: R2 first, so a failure leaves the project to delete again.
            const prefix = projectPrefix(userId, params.id);
            let cursor: string | undefined;
            do {
                const listed = await env.MATERIALS.list({ prefix, cursor });
                if (listed.objects.length > 0) await env.MATERIALS.delete(listed.objects.map((object) => object.key));
                cursor = listed.truncated ? listed.cursor : undefined;
            } while (cursor);
            await env.DB.prepare('DELETE FROM project WHERE id = ? AND user_id = ?').bind(params.id, userId).run();
            return { deleted: params.id };
        },
        {
            params: ProjectId,
            response: { 200: Deleted, ...errors },
            detail: { summary: 'Deletes a project, its materials and their files' },
        },
    )
    .get(
        '/:id/prepared-answers',
        async ({ userId, params }) => {
            const project = await mustFind(userId, params.id);
            const { results } = await env.DB.prepare(
                `SELECT id, name, text, qa FROM material WHERE project_id = ? AND user_id = ? AND error IS NULL ORDER BY created_at, id`,
            )
                .bind(params.id, userId)
                .all<{ id: string; name: string; text: string; qa: string | null }>();
            return {
                answers: results.flatMap((material) =>
                    preparedIn(material, project.language).map((found) => ({
                        question: found.q,
                        answer: found.a,
                        who: found.who,
                        source: found.source,
                        materialId: material.id,
                    })),
                ),
            };
        },
        {
            params: ProjectId,
            response: { 200: PreparedAnswers, ...errors },
            detail: { summary: "The questions and answers found in the project's materials, in the project's language" },
        },
    );
