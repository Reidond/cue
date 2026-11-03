import type { BriefState, Project } from '@cue/contract';

// Projects in D1 (migrations/0005_projects.sql, 0009_project_brief.sql). Every query carries the user id: a person sees only their own, and
// another's project is simply not found.

export interface ProjectRow {
    id: string;
    name: string;
    occasion: string;
    language: string;
    names_and_terms: string;
    brief_state: BriefState;
    brief_error: string | null;
    brief_occasion: string;
    brief_terms: string;
    brief_answers: string;
    brief_updated_at: number | null;
    created_at: number;
    last_used_at: number | null;
    material_count: number;
}

export const PROJECT_COLUMNS = `p.id AS id, p.name AS name, p.occasion AS occasion, p.language AS language, p.names_and_terms AS names_and_terms,
p.brief_state AS brief_state, p.brief_error AS brief_error, p.brief_occasion AS brief_occasion, p.brief_terms AS brief_terms,
p.brief_answers AS brief_answers, p.brief_updated_at AS brief_updated_at,
p.created_at AS created_at, p.last_used_at AS last_used_at, (SELECT COUNT(*) FROM material m WHERE m.project_id = p.id) AS material_count`;

/** The names and terms one by one (speech recognition's keyterms): written one per line or separated by commas or semicolons. */
export const termsOf = (namesAndTerms: string) =>
    namesAndTerms
        .split(/[,;\n]/)
        .map((term) => term.replace(/^[\s.]+|[\s.]+$/g, ''))
        .filter((term) => term !== '');

/** A prepared answer Cue wrote from the materials, as `brief_answers` keeps it. */
export interface BriefAnswer {
    q: string;
    a: string;
    who: string | null;
    source: string;
    materialId: string;
}

export const briefAnswersOf = (row: { brief_answers: string }): BriefAnswer[] => {
    try {
        return JSON.parse(row.brief_answers) as BriefAnswer[];
    } catch {
        return [];
    }
};

/** What the project goes by: the person's own words where they wrote any, else what Cue wrote from the materials. */
export const inUse = (row: { occasion: string; names_and_terms: string; brief_occasion: string; brief_terms: string }) => ({
    occasion: row.occasion.trim() === '' ? row.brief_occasion : row.occasion,
    namesAndTerms: row.names_and_terms.trim() === '' ? row.brief_terms : row.names_and_terms,
});

export const projectOf = (row: ProjectRow): Project => ({
    id: row.id,
    name: row.name,
    occasion: row.occasion,
    language: row.language,
    namesAndTerms: row.names_and_terms,
    terms: termsOf(inUse(row).namesAndTerms),
    brief: {
        state: row.brief_state,
        error: row.brief_error,
        occasion: row.brief_occasion,
        namesAndTerms: row.brief_terms,
        answerCount: briefAnswersOf(row).length,
        updatedAt: row.brief_updated_at,
    },
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    materialCount: row.material_count,
});

export async function findProject(db: D1Database, userId: string, id: string): Promise<ProjectRow | null> {
    return db.prepare(`SELECT ${PROJECT_COLUMNS} FROM project p WHERE p.id = ? AND p.user_id = ?`).bind(id, userId).first<ProjectRow>();
}

/** Where a project's files are in R2. */
export const projectPrefix = (userId: string, projectId: string) => `users/${userId}/projects/${projectId}/`;
