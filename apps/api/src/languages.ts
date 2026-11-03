import { LANGUAGES } from '@cue/contract';
import { lexiconFor } from './call/lexicon.ts';

// The languages a person reads Cue in (the `preference` table, migrations/0010_languages.sql). With two, Cue answers in the one the call is held
// in and translates each line into the other, and translates the notes; with one or none, everything is in the language heard.

export async function languagesOf(db: D1Database, userId: string): Promise<string[]> {
    const row = await db.prepare('SELECT languages FROM preference WHERE user_id = ?').bind(userId).first<{ languages: string }>();
    try {
        return row ? (JSON.parse(row.languages) as string[]) : [];
    } catch {
        return [];
    }
}

export async function setLanguages(db: D1Database, userId: string, languages: string[]): Promise<void> {
    await db
        .prepare(
            'INSERT INTO preference (user_id, languages, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET languages = excluded.languages, updated_at = excluded.updated_at',
        )
        .bind(userId, JSON.stringify(languages), Date.now())
        .run();
}

/** A language's name in English: "Ukrainian". */
export const nameOf = (code: string) => LANGUAGES.find((language) => language.code === code)?.name ?? lexiconFor(code).name;

/**
 * What to answer in, for two languages and the one heard: the heard one when it is one of them (what the person says), else the first; and the
 * other, to translate into. Null with fewer than two.
 */
export function pairFor(languages: string[], heard: string): { say: string; other: string } | null {
    if (languages.length < 2) return null;
    const base = heard.split('-')[0]!.toLowerCase();
    const say = languages.includes(base) ? base : languages[0]!;
    return { say, other: languages.find((language) => language !== say)! };
}
