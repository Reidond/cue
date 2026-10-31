import { MATERIAL_EXTENSIONS, MATERIAL_MAX_CHARS } from '@cue/contract';
import { toMarkdown } from './markdown.ts';
import { extractQA, type Prepared, type QaBlock, unmark } from './prepared.ts';
import { readSlides } from './slides.ts';

// Turns an uploaded file into what Cue uses: its text (Claude's context), the places that may hold prepared answers, and a word count.

export interface Extracted {
    text: string;
    /** Where to look for prepared answers when that isn't all of `text` (a slide deck's speaker notes). */
    qa: QaBlock[] | null;
    words: number;
    slides: number | null;
    /** Whether Workers AI read it (and is to be recorded as usage). */
    markdown: boolean;
}

/** The lower-case extension of a file name, without the dot. */
export const extensionOf = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

export const isSupported = (name: string) => {
    const extension = extensionOf(name);
    return [...MATERIAL_EXTENSIONS.text, ...MATERIAL_EXTENSIONS.slides, ...MATERIAL_EXTENSIONS.documents].some((known) => known === extension);
};

const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Reads a file. Throws an Error with a sentence for the person when it can't be read. */
export async function extract(name: string, bytes: ArrayBuffer, contentType: string): Promise<Extracted> {
    const extension = extensionOf(name);
    let result: Extracted;
    if ((MATERIAL_EXTENSIONS.text as readonly string[]).includes(extension)) {
        const body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes).trim();
        result = { text: `## ${name}\n${body}`, qa: null, words: wordsOf(body), slides: null, markdown: false };
    } else if ((MATERIAL_EXTENSIONS.slides as readonly string[]).includes(extension)) {
        const slides = readSlides(new Uint8Array(bytes), name);
        result = { text: slides.text, qa: slides.qa, words: wordsOf(slides.text), slides: slides.slides, markdown: false };
    } else {
        const converted = await toMarkdown(name, bytes, contentType);
        if (converted.format !== 'markdown') throw new Error(converted.error ?? `Cue can't read this ${extension.toUpperCase()} file.`);
        const body = converted.data.trim();
        if (body === '') throw new Error(extension === 'pdf' ? 'No text in this PDF (scanned?)' : 'No text in this file');
        result = { text: `## ${name}\n${body}`, qa: null, words: wordsOf(body), slides: null, markdown: true };
    }
    if (result.text.length > MATERIAL_MAX_CHARS) throw new Error('This file has too much text to use');
    return result;
}

/** What a stored material says about prepared answers, in the project's language. */
export function preparedIn(material: { name: string; text: string; qa: string | null }, language: string): Prepared[] {
    const blocks: QaBlock[] = material.qa ? (JSON.parse(material.qa) as QaBlock[]) : [{ source: material.name, lines: material.text.split(/\r?\n/).map(unmark) }];
    return blocks.flatMap((block) => extractQA(block.lines, language, block.source));
}

/** "1,204 words · 3 prepared answers", "12 slides · 2 prepared answers". */
export function summaryOf(material: { words: number; slides: number | null }, prepared: number): string {
    const size = material.slides === null ? `${material.words.toLocaleString('en-US')} words` : `${material.slides} slides`;
    return prepared === 0 ? size : `${size} · ${prepared} prepared answers`;
}
