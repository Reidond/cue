import {
    ApiError as ApiErrorBody,
    Brief,
    type BriefEvent,
    Deleted,
    NewProject,
    PreparedAnswers,
    Project,
    ProjectId,
    ProjectPatch,
    Projects,
} from '@cue/contract';
import { env } from 'cloudflare:workers';
import { Elysia, sse } from 'elysia';
import { ApiError } from '../errors.ts';
import { mustBeWithinLimit } from '../limits.ts';
import { preparedIn } from '../materials/read.ts';
import { briefAgain } from '../materials/workflow.ts';
import { briefAnswersOf, findProject, PROJECT_COLUMNS, type ProjectRow, projectOf, projectPrefix } from '../projects.ts';
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

/** A person's projects and every setting of one: its name, and their own occasion and names and terms where Cue's brief should not be used. */
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
                `INSERT INTO project (id, user_id, name, occasion, names_and_terms, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
                .bind(id, userId, cleanName(body.name), body.occasion ?? '', body.namesAndTerms ?? '', createdAt, body.lastUsedAt ?? null)
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
            const found = results.flatMap((material) =>
                preparedIn(material).map((item) => ({
                    question: item.q,
                    answer: item.a,
                    who: item.who,
                    source: item.source,
                    materialId: material.id,
                    from: 'materials' as const,
                })),
            );
            const prepared = briefAnswersOf(project).map((item) => ({
                question: item.q,
                answer: item.a,
                who: item.who,
                source: item.source,
                materialId: item.materialId,
                from: 'cue' as const,
            }));
            return { answers: [...found, ...prepared], brief: projectOf(project).brief };
        },
        {
            params: ProjectId,
            response: { 200: PreparedAnswers, ...errors },
            detail: {
                summary:
                    "The questions and answers written in the project's materials, then the ones Cue prepared from them (and how that is going)",
            },
        },
    )
    .post(
        '/:id/brief',
        async ({ userId, params, status }) => {
            await mustBeWithinLimit(userId);
            await mustFind(userId, params.id);
            await briefAgain(env.DB, userId, params.id);
            return status(202, projectOf(await mustFind(userId, params.id)).brief);
        },
        {
            params: ProjectId,
            response: { 202: Brief, ...errors, 402: ApiErrorBody },
            detail: {
                summary:
                    "Writes the project's brief from its materials again (it is written by itself whenever a file is added or removed)",
            },
        },
    )
    .get(
        '/:id/brief/events',
        async function* ({ userId, params }) {
            // The Workflow writes the brief's state to D1 (materials/workflow.ts): it is read here every half second for the first minute, then
            // every two, which keeps a whole stream under D1's queries per invocation. A beat every 15 s keeps the connection open.
            const started = Date.now();
            let last = '';
            let beat = started;
            while (Date.now() - started < 10 * 60_000) {
                const row = await findProject(env.DB, userId, params.id);
                // Deleted meanwhile.
                if (!row) return;
                const brief: BriefEvent = projectOf(row).brief;
                const seen = JSON.stringify(brief);
                if (seen !== last) {
                    last = seen;
                    yield sse({ event: 'brief', data: brief });
                }
                if (brief.state !== 'working') return;
                if (Date.now() - beat >= 15_000) {
                    beat = Date.now();
                    yield sse({ event: 'ping', data: {} });
                }
                await new Promise((resolve) => setTimeout(resolve, Date.now() - started < 60_000 ? 500 : 2000));
            }
        },
        {
            // An error thrown inside a streaming handler reaches no error hook: another person's project is refused before the stream starts.
            beforeHandle: async ({ userId, params }) => {
                await mustFind(userId, params.id);
            },
            params: ProjectId,
            detail: {
                summary:
                    'Server-sent events: the brief (`brief`) at once and whenever it changes while Cue writes it; the stream ends once it is no longer `working`',
            },
        },
    );
