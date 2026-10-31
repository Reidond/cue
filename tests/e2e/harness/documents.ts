// Files for the materials cases, built in the case: a PDF, a Word file and a PowerPoint file with the text a case gives them. They are small and
// plain (a PDF with its text uncompressed, Office files that are zips of the XML parts the readers look at), so the stand-in for Workers AI
// `toMarkdown` (fake-providers.ts) and the API's own slide reader can say exactly what is in them.
import { crc32 } from 'node:zlib';
import { inflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const u16 = (value: number) => Buffer.from([value & 255, (value >> 8) & 255]);
const u32 = (value: number) => Buffer.from([value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >>> 24) & 255]);

/** A zip file of `entries` (stored, not compressed). */
export function zip(entries: Record<string, string>): Buffer {
    const parts: Buffer[] = [];
    const directory: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(entries)) {
        const nameBytes = Buffer.from(name);
        const data = Buffer.from(text);
        const header = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crc32(data)), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes]);
        directory.push(
            Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0x21), u32(crc32(data)), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes]),
        );
        parts.push(header, data);
        offset += header.length + data.length;
    }
    const central = Buffer.concat(directory);
    return Buffer.concat([...parts, central, u32(0x06054b50), u16(0), u16(0), u16(directory.length), u16(directory.length), u32(central.length), u32(offset), u16(0)]);
}

/** The entries of a zip file, as text (stored or deflated). */
export function unzip(file: Buffer): Record<string, string> {
    const entries: Record<string, string> = {};
    const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) throw new Error('not a zip file');
    let cursor = file.readUInt32LE(end + 16);
    for (let count = file.readUInt16LE(end + 10); count > 0; count--) {
        const method = file.readUInt16LE(cursor + 10);
        const size = file.readUInt32LE(cursor + 20);
        const nameLength = file.readUInt16LE(cursor + 28);
        const extra = file.readUInt16LE(cursor + 30) + file.readUInt16LE(cursor + 32);
        const local = file.readUInt32LE(cursor + 42);
        const name = file.toString('utf8', cursor + 46, cursor + 46 + nameLength);
        const start = local + 30 + file.readUInt16LE(local + 26) + file.readUInt16LE(local + 28);
        const data = file.subarray(start, start + size);
        entries[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
        cursor += 46 + nameLength + extra;
    }
    return entries;
}

/** Writes a file, and the folders on the way to it. */
export function writeFile(path: string, content: string | Buffer): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
}

const escapeXml = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** A Word file with one paragraph per entry ('' is an empty paragraph). */
export function makeDocx(path: string, paragraphs: string[]): string {
    const body = paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`).join('');
    writeFile(
        path,
        zip({
            '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
            '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
            'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
        }),
    );
    return path;
}

/** A PDF with one line of text per entry on one page (uncompressed, so text can be read from it without a PDF library). */
export function makePdf(path: string, lines: string[]): string {
    const escape = (text: string) => text.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
    const stream = `BT /F1 12 Tf 72 740 Td 16 TL ${lines.map((line) => `(${escape(line)}) Tj T*`).join(' ')} ET`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ];
    let pdf = '%PDF-1.4\n';
    const offsets: number[] = [];
    objects.forEach((object, index) => {
        offsets.push(pdf.length);
        pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    });
    const xref = pdf.length;
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    writeFile(path, pdf);
    return path;
}

/** A PowerPoint file: a title and body on each slide, and its speaker notes. */
export function makePptx(path: string, slides: { title: string; body?: string; notes?: string[] }[]): string {
    const ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const shape = (placeholder: string, paragraphs: string[]) =>
        `<p:sp><p:nvSpPr><p:cNvPr id="1" name="x"/><p:cNvSpPr/><p:nvPr><p:ph type="${placeholder}"/></p:nvPr></p:nvSpPr><p:txBody>${paragraphs.map((text) => `<a:p><a:r><a:t>${escapeXml(text)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
    const entries: Record<string, string> = {
        'ppt/presentation.xml': `<p:presentation ${ns}><p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('')}</p:sldIdLst></p:presentation>`,
        'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, index) => `<Relationship Id="rId${index + 1}" Type="slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>`,
    };
    slides.forEach((slide, index) => {
        const number = index + 1;
        entries[`ppt/slides/slide${number}.xml`] =
            `<p:sld ${ns}><p:cSld><p:spTree>${shape('title', [slide.title])}${slide.body ? shape('body', [slide.body]) : ''}${shape('sldNum', ['9'])}</p:spTree></p:cSld></p:sld>`;
        entries[`ppt/slides/_rels/slide${number}.xml.rels`] =
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slide.notes ? `<Relationship Id="rId1" Type="notesSlide" Target="../notesSlides/notesSlide${number}.xml"/>` : ''}</Relationships>`;
        if (slide.notes) {
            entries[`ppt/notesSlides/notesSlide${number}.xml`] =
                `<p:notes ${ns}><p:cSld><p:spTree>${shape('sldImg', [''])}${shape('body', slide.notes)}</p:spTree></p:cSld></p:notes>`;
        }
    });
    writeFile(path, zip(entries));
    return path;
}
