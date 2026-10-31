import type { Project } from '@cue/contract';

// Projects in D1 (migrations/0005_projects.sql). Every query carries the user id: a person sees only their own, and another's project
// is simply not found.

export interface ProjectRow {
    id: string;
    name: string;
    occasion: string;
    language: string;
    names_and_terms: string;
    created_at: number;
    last_used_at: number | null;
    material_count: number;
}

export const PROJECT_COLUMNS = `p.id AS id, p.name AS name, p.occasion AS occasion, p.language AS language, p.names_and_terms AS names_and_terms,
p.created_at AS created_at, p.last_used_at AS last_used_at, (SELECT COUNT(*) FROM material m WHERE m.project_id = p.id) AS material_count`;

/** The names and terms one by one (speech recognition's keyterms): written one per line or separated by commas or semicolons. */
export const termsOf = (namesAndTerms: string) =>
    namesAndTerms
        .split(/[,;\n]/)
        .map((term) => term.replace(/^[\s.]+|[\s.]+$/g, ''))
        .filter((term) => term !== '');

export const projectOf = (row: ProjectRow): Project => ({
    id: row.id,
    name: row.name,
    occasion: row.occasion,
    language: row.language,
    namesAndTerms: row.names_and_terms,
    terms: termsOf(row.names_and_terms),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    materialCount: row.material_count,
});

export async function findProject(db: D1Database, userId: string, id: string): Promise<ProjectRow | null> {
    return db.prepare(`SELECT ${PROJECT_COLUMNS} FROM project p WHERE p.id = ? AND p.user_id = ?`).bind(id, userId).first<ProjectRow>();
}

/** Where a project's files are in R2. */
export const projectPrefix = (userId: string, projectId: string) => `users/${userId}/projects/${projectId}/`;
