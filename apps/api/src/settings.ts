import type { AdminSettings } from '@cue/contract';

// The owner's settings (`setting` table, edited in the admin SPA) and the limits that follow from them. A key without a row has its default.

export const DEFAULTS: AdminSettings = { defaultMonthlyLimitUsd: 20, audioRetentionDays: 30, planPaused: false };

const KEYS = {
    defaultMonthlyLimitUsd: 'default_monthly_limit_usd',
    audioRetentionDays: 'audio_retention_days',
    planPaused: 'plan_paused',
} as const satisfies Record<keyof AdminSettings, string>;

export async function readSettings(db: D1Database): Promise<AdminSettings> {
    const { results } = await db.prepare('SELECT key, value FROM setting').all<{ key: string; value: string }>();
    const stored = new Map(results.map((row) => [row.key, row.value]));
    const number = (key: string, fallback: number) => {
        const value = Number(stored.get(key));
        return stored.has(key) && Number.isFinite(value) ? value : fallback;
    };
    return {
        defaultMonthlyLimitUsd: number(KEYS.defaultMonthlyLimitUsd, DEFAULTS.defaultMonthlyLimitUsd),
        audioRetentionDays: number(KEYS.audioRetentionDays, DEFAULTS.audioRetentionDays),
        planPaused: stored.get(KEYS.planPaused) === '1',
    };
}

export async function writeSettings(db: D1Database, patch: Partial<AdminSettings>): Promise<void> {
    const statements = Object.entries(patch).flatMap(([name, value]) =>
        value === undefined
            ? []
            : [
                  db
                      .prepare('INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
                      .bind(KEYS[name as keyof AdminSettings], typeof value === 'boolean' ? (value ? '1' : '0') : String(value)),
              ],
    );
    if (statements.length > 0) await db.batch(statements);
}

export async function planPaused(db: D1Database): Promise<boolean> {
    const row = await db.prepare("SELECT value FROM setting WHERE key = 'plan_paused'").first<{ value: string }>();
    return row?.value === '1';
}
