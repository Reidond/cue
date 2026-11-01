import { DurableObject, env } from 'cloudflare:workers';
import { readSettings } from '../settings.ts';

/**
 * Deletes the audio of notes once their retention is over (admin › Settings › Audio retention: days after the notes were ready), and
 * the uploads nobody finished or used. One instance (`retention`) with an alarm that comes round every `RETENTION_TICK_SECONDS` while any audio
 * is in storage, and stops when none is; a note that becomes ready wakes it with `ensure`.
 */
export class Janitor extends DurableObject<Env> {
    /** Arms the alarm unless it is armed. */
    async ensure(): Promise<void> {
        if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + this.#tick());
    }

    override async alarm(): Promise<void> {
        const db = this.env.DB;
        const { audioRetentionDays } = await readSettings(db);
        const now = Date.now();
        const day = this.#day();
        const cutoff = now - audioRetentionDays * day;

        const { results: notes } = await db
            .prepare(
                "SELECT id, audio FROM note WHERE audio_deleted_at IS NULL AND ready_at IS NOT NULL AND ready_at <= ? AND audio != '{}' LIMIT 200",
            )
            .bind(cutoff)
            .all<{ id: string; audio: string }>();
        for (const note of notes) {
            await Promise.all(
                Object.values(JSON.parse(note.audio) as Record<string, string>).map((key) => this.env.RECORDINGS.delete(key)),
            );
            await db.prepare("UPDATE note SET audio = '{}', audio_deleted_at = ? WHERE id = ?").bind(now, note.id).run();
        }

        // Uploads that never became notes: an unfinished one is aborted after two days, a finished one goes with the retention.
        const { results: uploads } = await db
            .prepare(
                "SELECT upload_id, object_key, status FROM upload WHERE (status = 'open' AND created_at <= ?) OR (status = 'done' AND created_at <= ? AND object_key NOT IN (SELECT value FROM note, json_each(note.audio)))",
            )
            .bind(now - 2 * day, cutoff)
            .all<{ upload_id: string; object_key: string; status: string }>();
        for (const upload of uploads) {
            if (upload.status === 'open')
                await this.env.RECORDINGS.resumeMultipartUpload(upload.object_key, upload.upload_id)
                    .abort()
                    .catch(() => {});
            else await this.env.RECORDINGS.delete(upload.object_key);
            await db.prepare('DELETE FROM upload WHERE upload_id = ?').bind(upload.upload_id).run();
        }

        const more = await db
            .prepare("SELECT 1 AS found FROM note WHERE audio_deleted_at IS NULL AND audio != '{}' UNION ALL SELECT 1 FROM upload LIMIT 1")
            .first();
        if (more) await this.ctx.storage.setAlarm(Date.now() + this.#tick());
    }

    #tick() {
        const seconds = Number(env.RETENTION_TICK_SECONDS);
        return (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000;
    }

    #day() {
        const seconds = Number(env.RETENTION_DAY_SECONDS);
        return (Number.isFinite(seconds) && seconds > 0 ? seconds : 86400) * 1000;
    }
}

/** The Durable Object by its fixed name, typed with `Janitor`'s RPC methods (the generated types cannot follow the binding to its own Worker). */
export const janitor = () => (env.JANITOR as DurableObjectNamespace<Janitor>).getByName('retention');
