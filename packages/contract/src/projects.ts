import { type Static, Type } from '@sinclair/typebox';

// Projects and their materials (`/v1/projects`, docs/backend.md): one talk or series of calls, the files the person added to it (slides,
// documents, prepared answers) and the settings everything else follows. Times are milliseconds since the epoch.

const Language = Type.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$', description: 'The spoken language, as a code: en, uk, pl, …' });
const Name = Type.String({ minLength: 1, maxLength: 200 });

export const Project = Type.Object({
    id: Type.String(),
    name: Name,
    occasion: Type.String({ description: 'A sentence or two about the talk and who will be asking' }),
    language: Language,
    namesAndTerms: Type.String({
        description: "People's names, jargon, product names, as typed: one per line or separated by commas or semicolons",
    }),
    terms: Type.Array(Type.String(), { description: 'namesAndTerms, one by one (the speech recognition keyterms); read-only' }),
    createdAt: Type.Number(),
    lastUsedAt: Type.Union([Type.Number(), Type.Null()]),
    materialCount: Type.Integer(),
});
export type Project = Static<typeof Project>;

export const Projects = Type.Object({ projects: Type.Array(Project) });
export type Projects = Static<typeof Projects>;

/** `POST /v1/projects`. `createdAt` and `lastUsedAt` are for a client moving projects it kept locally into the account. */
export const NewProject = Type.Object({
    name: Name,
    occasion: Type.Optional(Type.String({ maxLength: 4000 })),
    language: Type.Optional(Language),
    namesAndTerms: Type.Optional(Type.String({ maxLength: 8000 })),
    createdAt: Type.Optional(Type.Number()),
    lastUsedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});
export type NewProject = Static<typeof NewProject>;

/** `PATCH /v1/projects/:id`: what is there changes, the rest stays. */
export const ProjectPatch = Type.Object({
    name: Type.Optional(Name),
    occasion: Type.Optional(Type.String({ maxLength: 4000 })),
    language: Type.Optional(Language),
    namesAndTerms: Type.Optional(Type.String({ maxLength: 8000 })),
    lastUsedAt: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
});
export type ProjectPatch = Static<typeof ProjectPatch>;

export const ProjectId = Type.Object({ id: Type.String() });
export const MaterialPath = Type.Object({ id: Type.String(), materialId: Type.String() });

export const Deleted = Type.Object({ deleted: Type.String() });

/** The extensions a material can have; the server reads each its own way (docs/backend.md › Materials). */
export const MATERIAL_EXTENSIONS = {
    /** Taken as they are. */
    text: ['md', 'markdown', 'txt'],
    /** Slides and their speaker notes, read by the API itself. */
    slides: ['pptx'],
    /** Workers AI `toMarkdown`. */
    documents: ['pdf', 'docx', 'xlsx', 'xls', 'xlsm', 'xlsb', 'et', 'ods', 'odt', 'csv', 'html', 'xml', 'numbers'],
} as const;
export const MATERIAL_MAX_BYTES = 25 * 1024 * 1024;
/** Longer than this (in characters) and a file's text can't be used as Claude's context. */
export const MATERIAL_MAX_CHARS = 1_000_000;

export const Material = Type.Object({
    id: Type.String(),
    name: Type.String(),
    contentType: Type.String(),
    size: Type.Integer({ description: 'Bytes of the file as uploaded' }),
    createdAt: Type.Number(),
    error: Type.Union([Type.String(), Type.Null()], { description: "Why its text couldn't be read; null when it was" }),
    summary: Type.String({
        description: '"1,204 words · 3 prepared answers", "12 slides · 2 prepared answers"; empty when it has an error',
    }),
    preparedCount: Type.Integer(),
});
export type Material = Static<typeof Material>;

export const Materials = Type.Object({ materials: Type.Array(Material) });
export type Materials = Static<typeof Materials>;

/** One material and the text the server extracted from it: what goes into Claude's prompt. */
export const MaterialText = Type.Composite([Material, Type.Object({ text: Type.String() })]);
export type MaterialText = Static<typeof MaterialText>;

export const UploadQuery = Type.Object({
    name: Type.String({ minLength: 1, maxLength: 255, description: 'The file name, with its extension' }),
});

/** A prepared question and answer found in a material (`Q: …` / `A: …`, or a question followed by an `Answer:` line, also in speaker notes). */
export const PreparedAnswer = Type.Object({
    question: Type.String(),
    answer: Type.String(),
    who: Type.Union([Type.String(), Type.Null()], { description: 'Who is expected to ask it: "(Smith)" after the question' }),
    source: Type.String({ description: 'The file, and the slide for speaker notes' }),
    materialId: Type.String(),
});
export type PreparedAnswer = Static<typeof PreparedAnswer>;

export const PreparedAnswers = Type.Object({ answers: Type.Array(PreparedAnswer) });
export type PreparedAnswers = Static<typeof PreparedAnswers>;
