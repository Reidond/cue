import { stems } from './knowledge.ts';

// The passages of long materials that answer a question. Up to MATERIALS_INLINE_CHARS the materials are Claude's whole system prompt, read
// from the cache for every question; past it (a thesis, a dozen papers) reading them all would cost each answer seconds, so the system prompt
// lists the files and each question comes with the passages that match it best. Two rankings are fused: words (BM25 over the same crude stems
// as the prepared answers' matcher, so it needs no model and is ready at once) and meaning (multilingual vectors, embeddings.ts: a question in
// Ukrainian finds the passage in an English file), the vectors' only once they are made.

/** Materials up to this many characters (about 35,000 tokens) go whole into the cached system prompt. */
export const MATERIALS_INLINE_CHARS = 120_000;
/** The passages a question comes with, in characters (about 7,000 tokens). */
export const EXCERPT_CHARS = 24_000;
/** A passage is paragraphs up to about this long; a longer paragraph is cut between lines, then sentences. */
const PASSAGE_CHARS = 1_400;
const PASSAGE_MAX_CHARS = 2_400;
/** The vectors are made this many passages at a time. */
const EMBED_BATCH = 32;
/** How long a question waits for its own vector before it goes with the word ranking alone. */
const QUERY_VECTOR_MS = 1_000;

export interface Material {
    name: string;
    text: string;
}

interface Passage {
    material: number;
    /** Where it is: the file, the heading above it and the page or slide it starts on. */
    label: string;
    text: string;
    terms: Map<string, number>;
    length: number;
}

export type Embed = (texts: string[]) => Promise<number[][] | null>;

const HEADING = /^#{1,6}\s+(.+?)\s*#*$/;
const PAGE = /\[p\.\s*(\d+)\]|^#+\s*Slide\s+(\d+)/i;

/** A material cut into passages of whole paragraphs, each knowing the heading and page it starts under. */
function passagesOf(material: Material, index: number, stopWords: Set<string>): Passage[] {
    const passages: Passage[] = [];
    let heading = '',
        page = '';
    let current: string[] = [],
        currentLength = 0,
        startHeading = '',
        startPage = '';
    const flush = () => {
        const text = current.join('\n\n').trim();
        current = [];
        currentLength = 0;
        if (text === '') return;
        const where = [startHeading, startPage === '' ? '' : `p. ${startPage}`].filter(Boolean).join(', ');
        const label = `${material.name}${where === '' ? '' : ` › ${where}`}`;
        const terms = new Map<string, number>();
        const words = stems(`${startHeading}\n${text}`, stopWords);
        for (const word of words) terms.set(word, (terms.get(word) ?? 0) + 1);
        passages.push({ material: index, label, text, terms, length: words.length });
    };
    for (const paragraph of material.text.split(/\n\s*\n/)) {
        for (const piece of pieces(paragraph.trim())) {
            const title = HEADING.exec(piece.split('\n', 1)[0] ?? '')?.[1];
            // A heading starts a passage of its own, unless the one before is too short to stand alone.
            if (currentLength > 0 && (currentLength + piece.length > PASSAGE_CHARS || (title !== undefined && currentLength > 400)))
                flush();
            if (currentLength === 0) {
                startHeading = title === undefined ? heading : title.slice(0, 120);
                startPage =
                    PAGE.exec(piece.split('\n', 1)[0] ?? '')
                        ?.slice(1)
                        .find(Boolean) ?? page;
                if (startHeading === material.name) startHeading = '';
            }
            current.push(piece);
            currentLength += piece.length + 2;
            for (const line of piece.split('\n')) {
                const title = HEADING.exec(line)?.[1];
                if (title !== undefined) heading = title.slice(0, 120);
                const marker = PAGE.exec(line);
                if (marker) page = marker[1] ?? marker[2] ?? page;
            }
        }
    }
    flush();
    return passages;
}

/** A paragraph in pieces no longer than PASSAGE_MAX_CHARS: whole when it fits, else cut between lines, then after sentences, then anywhere. */
function pieces(paragraph: string): string[] {
    if (paragraph.length <= PASSAGE_MAX_CHARS) return paragraph === '' ? [] : [paragraph];
    const units = paragraph.includes('\n') ? paragraph.split('\n') : paragraph.split(/(?<=[.!?…])\s+/);
    if (units.length === 1) {
        const cut: string[] = [];
        for (let start = 0; start < paragraph.length; start += PASSAGE_MAX_CHARS)
            cut.push(paragraph.slice(start, start + PASSAGE_MAX_CHARS));
        return cut;
    }
    const out: string[] = [];
    let piece = '';
    for (const unit of units.flatMap((unit) => pieces(unit))) {
        if (piece !== '' && piece.length + unit.length + 1 > PASSAGE_MAX_CHARS) {
            out.push(piece);
            piece = '';
        }
        piece = piece === '' ? unit : `${piece}\n${unit}`;
    }
    if (piece !== '') out.push(piece);
    return out;
}

const normalized = (vector: number[]): Float32Array => {
    const out = Float32Array.from(vector);
    let norm = 0;
    for (const value of out) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (let index = 0; index < out.length; index++) out[index] = (out[index] ?? 0) / norm;
    return out;
};

const dot = (a: Float32Array, b: Float32Array) => {
    let sum = 0;
    for (let index = 0; index < Math.min(a.length, b.length); index++) sum += (a[index] ?? 0) * (b[index] ?? 0);
    return sum;
};

/** A project's materials as passages, ranked against a question. */
export class Excerpts {
    readonly #materials: Material[];
    readonly #stopWords: Set<string>;
    readonly #passages: Passage[];
    readonly #documentFrequency = new Map<string, number>();
    readonly #averageLength: number;
    #vectors: Float32Array[] | null = null;
    #embed: Embed | undefined;
    /** Characters turned into vectors so far, for the usage table. */
    embedded = 0;

    constructor(materials: Material[], stopWords: Set<string>) {
        this.#materials = materials;
        this.#stopWords = stopWords;
        this.#passages = materials.flatMap((material, index) => passagesOf(material, index, stopWords));
        for (const passage of this.#passages) {
            for (const term of passage.terms.keys()) this.#documentFrequency.set(term, (this.#documentFrequency.get(term) ?? 0) + 1);
        }
        this.#averageLength = this.#passages.reduce((total, passage) => total + passage.length, 0) / Math.max(this.#passages.length, 1);
    }

    /** Whether materials this long go whole into the system prompt rather than in passages with each question. */
    static inline(materials: Material[]): boolean {
        return materials.reduce((total, material) => total + material.text.length, 0) <= MATERIALS_INLINE_CHARS;
    }

    get passages(): number {
        return this.#passages.length;
    }

    /**
     * Makes the passages' vectors with `embed`, a batch at a time. Until they are made, and for good when `embed` has no model or fails, the
     * passages are ranked by their words alone.
     */
    async index(embed: Embed): Promise<void> {
        const vectors: Float32Array[] = [];
        for (let start = 0; start < this.#passages.length; start += EMBED_BATCH) {
            const batch = this.#passages.slice(start, start + EMBED_BATCH).map((passage) => `${passage.label}\n${passage.text}`);
            const data = await embed(batch);
            if (!data) return;
            this.embedded += batch.reduce((total, text) => total + text.length, 0);
            vectors.push(...data.map(normalized));
        }
        this.#vectors = vectors;
        this.#embed = embed;
    }

    /** The system prompt's account of the materials: the files, each with its first headings, so Claude knows what there is to ask about. */
    outline(): string {
        const lines: string[] = [];
        let length = 0;
        for (const material of this.#materials) {
            const headings = material.text
                .split('\n')
                .map((line) => /^#{1,2}\s+(.+?)\s*#*$/.exec(line)?.[1]?.slice(0, 80))
                .filter((title): title is string => title !== undefined && title !== material.name)
                .filter((title, index, all) => all.indexOf(title) === index)
                .slice(0, 12);
            const line = `- ${material.name}${headings.length === 0 ? '' : `: ${headings.join('; ')}`}`;
            if (length + line.length > 8_000) {
                lines.push(`- … and ${this.#materials.length - lines.length} more files`);
                break;
            }
            lines.push(line);
            length += line.length;
        }
        return lines.join('\n');
    }

    /** The passages that answer `query` best, up to EXCERPT_CHARS, in the order the materials have them, each under its label. */
    async for(query: string): Promise<string> {
        const words = this.#bm25(query);
        const meaning = await this.#byVector(query);
        // Reciprocal rank fusion: a passage high in either ranking comes first, one high in both before it.
        const fused = new Map<number, number>();
        for (const ranking of [words, meaning]) {
            ranking.forEach((index, rank) => fused.set(index, (fused.get(index) ?? 0) + 1 / (60 + rank)));
        }
        const chosen: number[] = [];
        let length = 0;
        for (const [index] of [...fused].sort((a, b) => b[1] - a[1])) {
            const passage = this.#passages[index]!;
            if (chosen.length > 0 && length + passage.text.length > EXCERPT_CHARS) continue;
            chosen.push(index);
            length += passage.text.length;
            if (length >= EXCERPT_CHARS) break;
        }
        if (chosen.length === 0) return '';
        const blocks = chosen.sort((a, b) => a - b).map((index) => `[${this.#passages[index]!.label}]\n${this.#passages[index]!.text}`);
        return `Excerpts from the materials (the passages that match this question best):\n\n${blocks.join('\n\n')}`;
    }

    /** Passage indexes by BM25 score, best first, the ones that share no word with the query left out. */
    #bm25(query: string): number[] {
        const terms = [...new Set(stems(query, this.#stopWords))];
        const count = this.#passages.length;
        const scores: [number, number][] = [];
        this.#passages.forEach((passage, index) => {
            let score = 0;
            for (const term of terms) {
                const frequency = passage.terms.get(term);
                if (!frequency) continue;
                const documents = this.#documentFrequency.get(term) ?? 0;
                const idf = Math.log(1 + (count - documents + 0.5) / (documents + 0.5));
                score += (idf * frequency * 2.2) / (frequency + 1.2 * (0.25 + (0.75 * passage.length) / this.#averageLength));
            }
            if (score > 0) scores.push([index, score]);
        });
        return scores
            .sort((a, b) => b[1] - a[1])
            .slice(0, 40)
            .map(([index]) => index);
    }

    /** Passage indexes by closeness of meaning, best first; none when the vectors aren't made or the question's own isn't there in time. */
    async #byVector(query: string): Promise<number[]> {
        const vectors = this.#vectors;
        const embed = this.#embed;
        if (!vectors || !embed) return [];
        const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), QUERY_VECTOR_MS));
        const data = await Promise.race([embed([query]).catch(() => null), timeout]);
        const vector = data?.[0];
        if (!vector) return [];
        this.embedded += query.length;
        const target = normalized(vector);
        return vectors
            .map((candidate, index) => [index, dot(candidate, target)] as const)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 40)
            .map(([index]) => index);
    }
}
