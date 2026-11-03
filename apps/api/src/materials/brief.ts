import briefTemplate from '../../prompts/brief.md?raw';
import type { BriefAnswer } from '../projects.ts';
import type { Prepared } from './prepared.ts';

// The brief: what Cue writes from a project's materials, so that the person only has to add their files. Claude reads them and writes the
// occasion, the names and terms speech recognition should listen for, and answers to the questions people are likely to ask
// (prompts/brief.md). Made by the BriefWorkflow (workflow.ts) a few seconds after the files last changed.

/** The materials Claude reads for a brief, in characters (about 100,000 tokens): a library bigger than that is read from its start. */
export const BRIEF_MAX_CHARS = 400_000;
const MAX_TERMS = 40;
const MAX_ANSWERS = 30;

export const briefPrompt = () => briefTemplate.trim();

/** The user message: the materials' texts, then the questions they already answer themselves. */
export function briefMessage(texts: string[], found: Prepared[]): string {
    let message = `Materials:\n\n${texts.filter((text) => text !== '').join('\n\n')}`.slice(0, BRIEF_MAX_CHARS);
    if (found.length > 0) message += `\n\n# PREPARED IN THE MATERIALS\n\n${found.map((item) => `- ${item.q}`).join('\n')}`;
    return message;
}

export interface Brief {
    occasion: string;
    /** One per line. */
    namesAndTerms: string;
    answers: BriefAnswer[];
}

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/**
 * Claude's reply read as a brief: the JSON object in it (a code fence around it is allowed), with what does not fit left out. An answer's
 * material is the file its source names (the longest name that starts it), else the first one. Throws when there is no object to read.
 */
export function parseBrief(reply: string, materials: { id: string; name: string }[]): Brief {
    const start = reply.indexOf('{');
    const end = reply.lastIndexOf('}');
    let parsed: Record<string, unknown>;
    try {
        if (start < 0 || end < start) throw new Error('no object');
        parsed = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
        throw new Error("Claude's reply could not be read");
    }
    const byLength = materials.toSorted((a, b) => b.name.length - a.name.length);
    const materialOf = (source: string) =>
        (byLength.find((material) => source.toLowerCase().startsWith(material.name.toLowerCase())) ?? materials[0])?.id ?? '';
    const terms = (Array.isArray(parsed['namesAndTerms']) ? parsed['namesAndTerms'] : [])
        .map((term) => text(term, 100).replace(/[\n,;]+/g, ' '))
        .filter((term, index, all) => term !== '' && all.indexOf(term) === index)
        .slice(0, MAX_TERMS);
    const answers = (Array.isArray(parsed['answers']) ? parsed['answers'] : [])
        .map((item): BriefAnswer | null => {
            if (typeof item !== 'object' || item === null) return null;
            const entry = item as Record<string, unknown>;
            const q = text(entry['question'], 600);
            const a = text(entry['answer'], 3000);
            if (q === '' || a === '') return null;
            const source = text(entry['source'], 300);
            const who = text(entry['who'], 80);
            return {
                q,
                a,
                who: who === '' ? null : who,
                source: source === '' ? (materials[0]?.name ?? '') : source,
                materialId: materialOf(source),
            };
        })
        .filter((answer) => answer !== null)
        .slice(0, MAX_ANSWERS);
    return { occasion: text(parsed['occasion'], 1000), namesAndTerms: terms.join('\n'), answers };
}
