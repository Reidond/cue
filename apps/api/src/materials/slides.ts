import { unzipSync, strFromU8 } from 'fflate';
import type { QaBlock } from './prepared.ts';

// A PowerPoint file's slides and speaker notes (ported from the Mac app's Materials.swift: `OfficeXML` and the slide readers). Workers AI
// `toMarkdown` doesn't take .pptx, and the notes are where speakers keep prepared answers.

interface Tag {
    kind: 'open' | 'close' | 'text';
    name: string;
    attributes: Record<string, string>;
    text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (text: string) =>
    text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
        if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
        if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
        return ENTITIES[entity] ?? whole;
    });

/** A minimal XML tokenizer: start and end tags (a self-closing one is both) and text. */
function* tags(xml: string): Generator<Tag> {
    const pattern =
        /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    for (const match of xml.matchAll(pattern)) {
        const [, cdata, closing, name, attributeText, selfClosing, text] = match;
        if (cdata !== undefined) yield { kind: 'text', name: '', attributes: {}, text: cdata };
        else if (text !== undefined) yield { kind: 'text', name: '', attributes: {}, text: decode(text) };
        else if (name !== undefined) {
            const attributes: Record<string, string> = {};
            for (const attribute of (attributeText ?? '').matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
                attributes[attribute[1]!] = decode(attribute[2] ?? attribute[3] ?? '');
            }
            if (closing) yield { kind: 'close', name, attributes: {}, text: '' };
            else {
                yield { kind: 'open', name, attributes, text: '' };
                if (selfClosing) yield { kind: 'close', name, attributes: {}, text: '' };
            }
        }
    }
}

const attributeValues = (xml: string, element: string, attribute: string) =>
    [...tags(xml)].flatMap((tag) =>
        tag.kind === 'open' && tag.name === element && tag.attributes[attribute] !== undefined ? [tag.attributes[attribute]!] : [],
    );

const trim = (text: string) => text.replace(/^[\p{Zs}\t]+|[\p{Zs}\t]+$/gu, '');

/**
 * The paragraphs of a slide, or of its notes. In a slide, placeholders decide what counts as content (not the slide number, date, footer);
 * in notes only the body placeholder does. Runs of blank paragraphs collapse into one: a single blank separates Q&A blocks.
 */
function paragraphs(xml: string, mode: 'slide' | 'notes'): string[] {
    const found: string[] = [];
    let current = '';
    let inText = false;
    let inParagraph = false;
    let shapeDepth = 0;
    let placeholder: string | undefined;
    let shape: string[] = [];
    const keepsShape = () => (mode === 'notes' ? placeholder === 'body' : !['sldNum', 'dt', 'ftr', 'sldImg'].includes(placeholder ?? ''));
    for (const tag of tags(xml)) {
        if (tag.kind === 'text') {
            if (inText) current += tag.text;
        } else if (tag.kind === 'open') {
            if (tag.name === 'a:p') {
                inParagraph = true;
                current = '';
            } else if (tag.name === 'a:t') inText = true;
            else if (tag.name === 'a:br' && inParagraph) current += '\n';
            else if (tag.name === 'p:sp') {
                shapeDepth++;
                if (shapeDepth === 1) {
                    placeholder = undefined;
                    shape = [];
                }
            } else if (tag.name === 'p:ph') placeholder = tag.attributes['type'] ?? 'body';
        } else if (tag.name === 'a:t') inText = false;
        else if (tag.name === 'a:p') {
            inParagraph = false;
            const text = trim(current);
            if (shapeDepth > 0) shape.push(text);
            else found.push(text);
        } else if (tag.name === 'p:sp') {
            shapeDepth--;
            if (shapeDepth === 0 && keepsShape()) found.push(...shape, '');
        }
    }
    const result: string[] = [];
    for (const paragraph of found) if (!(paragraph === '' && (result.at(-1) ?? '') === '')) result.push(paragraph);
    return result;
}

/** `Target` of each relationship by `Id`. */
function relationships(xml: string | undefined): Map<string, string> {
    if (!xml) return new Map();
    const ids = attributeValues(xml, 'Relationship', 'Id');
    const targets = attributeValues(xml, 'Relationship', 'Target');
    return new Map(ids.map((id, index) => [id, targets[index]!] as const).reverse());
}

export interface Slides {
    text: string;
    qa: QaBlock[];
    slides: number;
}

/** Throws when the bytes aren't a slide deck. */
export function readSlides(bytes: Uint8Array, name: string): Slides {
    const files = unzipSync(bytes, { filter: (file) => file.name.endsWith('.xml') || file.name.endsWith('.rels') });
    const entry = (path: string) => {
        const data = files[path];
        return data ? strFromU8(data) : undefined;
    };
    const presentation = entry('ppt/presentation.xml');
    const presentationRels = entry('ppt/_rels/presentation.xml.rels');
    if (!presentation || !presentationRels) throw new Error('Not a valid PowerPoint file');
    const rels = relationships(presentationRels);
    const order = attributeValues(presentation, 'p:sldId', 'r:id')
        .map((id) => rels.get(id))
        .filter((target): target is string => target !== undefined)
        .map((target) => `ppt/${target.replaceAll('../', '')}`);

    const parts: string[] = [];
    const qa: QaBlock[] = [];
    order.forEach((path, index) => {
        const number = index + 1;
        const slide = paragraphs(entry(path) ?? '', 'slide');
        let section = `### Slide ${number}\n${slide.join('\n')}`;
        const slideRels = relationships(entry(`${path.replace('slides/', 'slides/_rels/')}.rels`));
        const notesTarget = [...slideRels.values()].find((target) => target.includes('notesSlide'));
        if (notesTarget) {
            const notes = paragraphs(entry(`ppt/notesSlides/${notesTarget.split('/').at(-1)}`) ?? '', 'notes');
            if (notes.length > 0) {
                section += `\nSpeaker notes:\n${notes.join('\n')}`;
                qa.push({ source: `${name}, slide ${number} notes`, lines: notes });
            }
        }
        parts.push(section);
    });
    return { text: `## ${name} (slides with speaker notes)\n${parts.join('\n\n')}`, qa, slides: order.length };
}
