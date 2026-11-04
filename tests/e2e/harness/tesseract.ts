// The second reader of images on a Mac: Tesseract, for where Vision's accurate text recognizer can't run (the Cue macOS VM, where it
// fails on every device and the fast one reads neither Cyrillic nor small text; tools/ocr.swift says so). It is tesseract.js, Tesseract
// built to WebAssembly, with the English and Ukrainian data of @tesseract.js-data, all in tests/e2e's packages: nothing is downloaded.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Tesseract from 'tesseract.js';
import { E2E_CACHE, E2E_ROOT } from './config.ts';

/** A line of text and where it is, in the image's pixels. */
export interface ReadLine {
    text: string;
    top: number;
    bottom: number;
    left: number;
    right: number;
    /** How sure Tesseract is of it, 0–100. */
    confidence: number;
}

/** Tesseract reads icons as a letter or two, with little confidence; text it reads with 80 % or more. */
const LEAST_CONFIDENCE = 40;

/**
 * Each image is read in English and, apart, in English and Ukrainian, and a line's second reading is kept when it is this much surer.
 * Ukrainian it reads 90–96 % sure in the second and 10–75 % in the first, but reading both languages it spells English with Cyrillic
 * lookalikes now and then ("None" as "Мопе", "in" as "іп", "0 files" as "О files"), as sure as it reads them in English alone, give or take 5.
 */
const SURER = 10;

/** Its workers by language (each reads one image at a time), made the first time they're needed: their data takes a second to load. */
const workers = new Map<string, Promise<Tesseract.Worker>>();

/** A worker that reads in these languages, for the `index`th of the images read at once. */
function worker(languages: string[], index: number): Promise<Tesseract.Worker> {
    const key = `${languages.join('+')} ${index}`;
    const found = workers.get(key);
    if (found) return found;
    const made = (async () => {
        const { default: tesseract } = await import('tesseract.js');
        // It reads every language from one folder (and makes a language of data handed to it).
        const langPath = join(E2E_CACHE, 'tesseract');
        mkdirSync(langPath, { recursive: true });
        for (const code of ['eng', 'ukr']) {
            const name = `${code}.traineddata.gz`;
            const from = join(E2E_ROOT, 'node_modules', '@tesseract.js-data', code, '4.0.0_best_int', name);
            const to = join(langPath, name);
            if (statSync(to, { throwIfNoEntry: false })?.size !== statSync(from).size) copyFileSync(from, to);
        }
        const reader = await tesseract.createWorker(languages, tesseract.OEM.LSTM_ONLY, { langPath, cacheMethod: 'none' });
        await reader.setParameters({
            // A window is text scattered in labels, buttons and columns, not a page of paragraphs.
            tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT,
            // Sauvola's threshold, worked out around each pixel: Otsu's, one for the whole window, lost white text on an accent button.
            thresholding_method: '2',
            // Not "Estimating resolution as N" for every image.
            debug_file: '/dev/null',
        });
        return reader;
    })();
    workers.set(key, made);
    return made;
}

/** The lines Tesseract reads in each image (dark text on white: `ocr --prepare` writes them), all at once. */
export function readLines(...pngs: string[]): Promise<ReadLine[][]> {
    return Promise.all(
        pngs.map(async (png, index) => {
            const [english = [], both = []] = await Promise.all(
                [['eng'], ['eng', 'ukr']].map(async (languages) => {
                    const { data } = await (await worker(languages, index)).recognize(png, {}, { blocks: true, text: false });
                    return (data.blocks ?? []).flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines));
                }),
            );
            // Each line of the second reading goes with the line of the first it overlaps most (a stray mark can overlap a line too).
            const second = new Map<Tesseract.Line, Tesseract.Line>();
            for (const line of both) {
                const match = mostOverlapped(english, line);
                const had = match && second.get(match);
                if (match && (!had || overlap(match, line) > overlap(match, had))) second.set(match, line);
            }
            const alone = both.filter((line) => !english.some((first) => overlap(first, line) > 0));
            return [...english.map((line) => surer(line, second.get(line))), ...alone]
                .filter((line) => line.confidence >= LEAST_CONFIDENCE && line.text.trim() !== '')
                .map(({ text, bbox, confidence }) => ({
                    text: corrected(text.trim()),
                    top: bbox.y0,
                    bottom: bbox.y1,
                    left: bbox.x0,
                    right: bbox.x1,
                    confidence,
                }));
        }),
    );
}

/** A line's reading in English and Ukrainian when it is surer by `SURER`, else its reading in English. */
function surer(english: Tesseract.Line, both: Tesseract.Line | undefined): Tesseract.Line {
    return both && both.confidence >= english.confidence + SURER ? both : english;
}

/** How many pixels two lines share. */
function overlap(a: Tesseract.Line, b: Tesseract.Line): number {
    const width = Math.min(a.bbox.x1, b.bbox.x1) - Math.max(a.bbox.x0, b.bbox.x0);
    const height = Math.min(a.bbox.y1, b.bbox.y1) - Math.max(a.bbox.y0, b.bbox.y0);
    return Math.max(0, width) * Math.max(0, height);
}

/** The line of `lines` that `line` overlaps most, if it overlaps any. */
function mostOverlapped(lines: Tesseract.Line[], line: Tesseract.Line): Tesseract.Line | undefined {
    const [best] = lines.filter((other) => overlap(other, line) > 0).sort((a, b) => overlap(b, line) - overlap(a, line));
    return best;
}

/**
 * What Tesseract misreads in Cue's snapshots and can be told from the rest: a capital I alone as "|" ("| will send them"), and as "l"
 * before a consonant, which no English word starts with ("Petro lvanenko"); a word in the other alphabet's lookalikes.
 */
function corrected(line: string): string {
    return oneAlphabet(line.replace(/(?<!\S)\|(?!\S)/g, 'I').replace(/(?<![\p{L}\p{N}])l(?=[bcdfghjkmnpqrstvwxz])/gu, 'I'));
}

/** Latin letters and the Cyrillic ones drawn the same. */
const TO_CYRILLIC = new Map(
    Object.entries({
        A: 'А',
        B: 'В',
        C: 'С',
        E: 'Е',
        H: 'Н',
        I: 'І',
        K: 'К',
        M: 'М',
        O: 'О',
        P: 'Р',
        T: 'Т',
        X: 'Х',
        a: 'а',
        c: 'с',
        e: 'е',
        i: 'і',
        o: 'о',
        p: 'р',
        x: 'х',
        y: 'у',
    }),
);
const TO_LATIN = new Map([...TO_CYRILLIC].map(([latin, cyrillic]) => [cyrillic, latin]));

/**
 * Reading English and Ukrainian at once, Tesseract now and then spells a word with the other alphabet's lookalikes ("Ha" for "на"): a
 * word made only of its line's alphabet and lookalikes is written in that alphabet, the one most of the line's other letters are in.
 */
function oneAlphabet(line: string): string {
    const count = (pattern: RegExp, lookalikes: Map<string, string>): number =>
        [...line.matchAll(pattern)].filter(([letter]) => !lookalikes.has(letter)).length;
    const [cyrillic, latin] = [count(/\p{Script=Cyrillic}/gu, TO_LATIN), count(/\p{Script=Latin}/gu, TO_CYRILLIC)];
    if (cyrillic === latin) return line;
    const [own, into] = cyrillic > latin ? [/\p{Script=Cyrillic}/u, TO_CYRILLIC] : [/\p{Script=Latin}/u, TO_LATIN];
    return line.replace(/\p{L}+/gu, (word) =>
        word.match(/\p{L}/gu)?.every((letter) => own.test(letter) || into.has(letter))
            ? word.replace(/\p{L}/gu, (letter) => into.get(letter) ?? letter)
            : word,
    );
}

/** Ends the workers, threads that would keep the process alive. */
export async function closeReader(): Promise<void> {
    const made = [...workers.values()];
    workers.clear();
    await Promise.all(made.map(async (reader) => (await reader.catch(() => undefined))?.terminate()));
}
