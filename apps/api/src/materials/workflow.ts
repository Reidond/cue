import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { describe, send } from '../call/anthropic.ts';
import { ANSWER_MODEL, noThinking } from '../call/models.ts';
import { tokenUsage } from '../pricing.ts';
import { limitState, recordUsage } from '../usage.ts';
import { briefMessage, briefPrompt, parseBrief } from './brief.ts';
import { preparedIn } from './read.ts';

// The Workflow that writes a project's brief (brief.ts), bound as `BRIEF`. Each change to the files starts one for the version it made; it
// waits for the files to settle, and only the Workflow of the latest version reads them and writes the brief.

export interface BriefParams {
    userId: string;
    projectId: string;
    version: number;
}

/** Seconds of quiet after the last change before the materials are read: files dropped together, or a library imported, are read once. */
const settle = () => {
    const seconds = Number(env.BRIEF_SETTLE_SECONDS);
    return `${Number.isFinite(seconds) && seconds > 0 ? seconds : 3} seconds` as const;
};

/** A failure as people read it (a step's error arrives as its message alone): no full stop at the end, the session log goes on after it. */
const reasonOf = (error: unknown) => {
    const message = error instanceof Error && error.message !== '' ? error.message : describe(error);
    return message.replace(/^NonRetryableError:\s*/, '').replace(/[. ]+$/, '');
};

/**
 * The project's files changed (or the person asked for the brief again): the version is counted, and a Workflow for it started. Without files
 * the brief is simply cleared. A Workflow still at work for an older version then writes nothing.
 */
export async function briefAgain(db: D1Database, userId: string, projectId: string): Promise<void> {
    const row = await db
        .prepare(
            `UPDATE project SET materials_version = materials_version + 1, brief_error = NULL,
             brief_state = CASE WHEN EXISTS (SELECT 1 FROM material m WHERE m.project_id = project.id) THEN 'working' ELSE 'none' END
             WHERE id = ? AND user_id = ? RETURNING materials_version AS version, brief_state AS state`,
        )
        .bind(projectId, userId)
        .first<{ version: number; state: string }>();
    if (!row) return;
    if (row.state === 'none') {
        await db
            .prepare(
                "UPDATE project SET brief_occasion = '', brief_terms = '', brief_answers = '[]', brief_updated_at = ?, brief_version = ? WHERE id = ? AND user_id = ?",
            )
            .bind(Date.now(), row.version, projectId, userId)
            .run();
        return;
    }
    await env.BRIEF.create({ id: `${projectId}-${row.version}`, params: { userId, projectId, version: row.version } });
}

export class BriefWorkflow extends WorkflowEntrypoint<Env, BriefParams> {
    async run(event: Readonly<WorkflowEvent<BriefParams>>, step: WorkflowStep) {
        const params = event.payload;
        const db = this.env.DB;
        await step.sleep('settle', settle());
        const current = await step.do('version', async () => {
            const row = await db
                .prepare('SELECT materials_version FROM project WHERE id = ? AND user_id = ?')
                .bind(params.projectId, params.userId)
                .first<{ materials_version: number }>();
            return row?.materials_version ?? null;
        });
        // Another change came since (its own Workflow writes the brief), or the project is gone.
        if (current !== params.version) return;
        if (await step.do('limit', async () => (await limitState(db, params.userId)).over)) {
            await step.do('limited', () => failed(db, params, 'Cue plan limit reached'));
            return;
        }
        try {
            await step.do('brief', { retries: { limit: 2, delay: '10 seconds', backoff: 'constant' }, timeout: '10 minutes' }, () =>
                write(db, params),
            );
        } catch (error) {
            await step.do('failed', () => failed(db, params, reasonOf(error)));
        }
    }
}

/** Claude reads the materials and writes the brief; it is kept only if no file changed meanwhile. */
async function write(db: D1Database, { userId, projectId, version }: BriefParams): Promise<void> {
    const { results } = await db
        .prepare('SELECT id, name, text, qa FROM material WHERE project_id = ? AND user_id = ? AND error IS NULL ORDER BY created_at, id')
        .bind(projectId, userId)
        .all<{ id: string; name: string; text: string; qa: string | null }>();
    if (results.length === 0) throw new Error("Cue couldn't read any of the files");
    const message = briefMessage(
        results.map((material) => material.text),
        results.flatMap((material) => preparedIn(material)),
    );
    let reply: Awaited<ReturnType<typeof send>>;
    try {
        reply = await send({
            model: ANSWER_MODEL,
            max_tokens: 8000,
            thinking: noThinking(ANSWER_MODEL),
            system: briefPrompt(),
            messages: [{ role: 'user', content: message }],
        });
    } catch (error) {
        throw new Error(describe(error));
    }
    const { text, tokens } = reply;
    await recordUsage(db, userId, tokenUsage('materials_brief', ANSWER_MODEL, tokens));
    const brief = parseBrief(text, results);
    await db
        .prepare(
            `UPDATE project SET brief_state = 'ready', brief_error = NULL, brief_occasion = ?, brief_terms = ?, brief_answers = ?, brief_updated_at = ?,
             brief_version = ? WHERE id = ? AND user_id = ? AND materials_version = ?`,
        )
        .bind(brief.occasion, brief.namesAndTerms, JSON.stringify(brief.answers), Date.now(), version, projectId, userId, version)
        .run();
}

/** The brief could not be written: the one before stays in use, and the project says why. */
async function failed(db: D1Database, { userId, projectId, version }: BriefParams, why: string): Promise<void> {
    await db
        .prepare(
            "UPDATE project SET brief_state = 'failed', brief_error = ?, brief_version = ? WHERE id = ? AND user_id = ? AND materials_version = ?",
        )
        .bind(why, version, projectId, userId, version)
        .run();
}
