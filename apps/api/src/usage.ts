import type { UsageRow } from './call/models.ts';
import { DEFAULTS } from './settings.ts';

// Months, days and what a person has spent: the arithmetic shared by `/v1/me` and the admin API. The `usage` table holds seconds since the epoch
// and millionths of a US dollar.

/** The UTC month, `YYYY-MM`. */
export const monthOf = (at: Date = new Date()) => at.toISOString().slice(0, 7);

/** The seconds-since-epoch range `[from, to)` of a UTC month. */
export function monthRange(month: string): { from: number; to: number } {
    const [year, number] = month.split('-').map(Number) as [number, number];
    return { from: Date.UTC(year, number - 1, 1) / 1000, to: Date.UTC(year, number, 1) / 1000 };
}

/** What one person may spend in a month, and has: their own limit or the default. */
export async function accountUsage(db: D1Database, userId: string, month: string) {
    const { from, to } = monthRange(month);
    const [settings, limit, spent] = await db.batch([
        db.prepare("SELECT value FROM setting WHERE key = 'default_monthly_limit_usd'"),
        db.prepare('SELECT monthly_usd FROM user_limit WHERE user_id = ?').bind(userId),
        db
            .prepare(
                `SELECT COALESCE(SUM(cost_micros), 0) AS micros,
COALESCE(SUM(CASE WHEN unit = 'audio_seconds' THEN units ELSE 0 END), 0) AS audio_seconds
FROM usage WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
            )
            .bind(userId, from, to),
    ]);
    const stored = Number((settings?.results[0] as { value: string } | undefined)?.value);
    const own = (limit?.results[0] as { monthly_usd: number } | undefined)?.monthly_usd;
    const row = spent?.results[0] as { micros: number; audio_seconds: number };
    return {
        limitUsd: own ?? (Number.isFinite(stored) ? stored : DEFAULTS.defaultMonthlyLimitUsd),
        usd: row.micros / 1e6,
        audioSeconds: row.audio_seconds,
    };
}

/** Every day of a UTC month as `YYYY-MM-DD`. */
export function daysOf(month: string): string[] {
    const { from, to } = monthRange(month);
    return Array.from({ length: (to - from) / 86400 }, (_, index) => new Date((from + index * 86400) * 1000).toISOString().slice(0, 10));
}

/** `spent` (by day, in millionths of a dollar) laid over every day of the month. */
export const fillDays = (month: string, spent: Map<string, number>) =>
    daysOf(month).map((date) => ({ date, usd: (spent.get(date) ?? 0) / 1e6 }));

/** What reading one file with Workers AI `toMarkdown` costs, in millionths of a dollar: PDFs and Office files are free (images are not, and are not accepted). */
export const TOMARKDOWN_MICROS_PER_FILE = 0;

/** Records what a person used: one `usage` row each. */
export async function recordUsage(db: D1Database, userId: string, rows: UsageRow[]): Promise<void> {
    if (rows.length === 0) return;
    const insert = db.prepare(
        'INSERT INTO usage (user_id, feature, provider, model, units, unit, cost_micros) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    await db.batch(
        rows.map(([feature, provider, model, units, unit, cost]) => insert.bind(userId, feature, provider, model, units, unit, cost)),
    );
}
