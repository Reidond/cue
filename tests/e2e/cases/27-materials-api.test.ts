import { statSync } from 'node:fs';
import {
    assertDeepEq,
    assertEq,
    assertTextContains,
    assertTextNotContains,
    e2eCase,
    fixture,
    makeDocx,
    makePdf,
    makePptx,
    writeFile,
} from '../harness/index.ts';

interface Material {
    id: string;
    name: string;
    size: number;
    error: string | null;
    summary: string;
    preparedCount: number;
}
interface Answer {
    question: string;
    answer: string;
    who: string | null;
    source: string;
    materialId: string;
}

e2eCase('Files added to a project are stored, read on the server, and their prepared answers found there.', async (cue) => {
    const backend = await cue.backend();
    const email = 'ann@cue.test';
    await backend.invite(email);
    const token = (await backend.tokensFor(email)).access_token;
    const project = (await backend.call('POST', '/v1/projects', token, { body: { name: 'Bee talk', language: 'en' } })).body as {
        id: string;
    };
    const base = `/v1/projects/${project.id}`;
    const upload = (path: string, name?: string) => backend.call('POST', `${base}/materials`, token, { file: { path, name } });
    const answers = async () => (await backend.call('GET', `${base}/prepared-answers`, token)).body.answers as Answer[];

    // Markdown is read as it is.
    const talk = await upload(fixture('materials', 'talk.md'));
    assertEq(talk.status, 201, 'uploading talk.md');
    assertEq(talk.body.summary, '133 words · 3 prepared answers', 'what the server says about it');
    const text = await backend.call('GET', `${base}/materials/${talk.body.id}`, token);
    assertTextContains(text.body.text, /^## talk\.md$/);
    assertTextContains(text.body.text, /48 hives on 6 rooftops/);
    assertDeepEq(
        (await answers()).map((item) => item.question),
        ['How many hives did you study?', 'Why did you put the hives on rooftops?', 'What were the winter losses?'],
    );
    assertEq((await answers())[0]?.answer, 'We studied 48 hives on 6 rooftops in Kyiv over two seasons.');
    assertEq((await answers())[0]?.source, 'talk.md');

    // The same file again is the same material; a different one with the name gets a number.
    const again = await upload(fixture('materials', 'talk.md'));
    assertEq(again.status, 200, 'the same file again');
    assertEq(again.body.id, talk.body.id);
    const other = cue.path('files', 'talk.md');
    writeFile(other, 'Q: Is it different?\nA: Yes, it is.\n');
    const second = await upload(other);
    assertEq(second.status, 201);
    assertEq(second.body.name, 'talk 2.md', 'a different file with the same name');
    assertEq((await answers()).length, 4);

    // Word and PDF go through Workers AI's toMarkdown (the stand-in here).
    const docx = makeDocx(cue.path('files', 'prepared.docx'), [
        'Prepared answers',
        '',
        '1. How were the hives weighed? (Smith)',
        'Answer: Every week, on a platform scale.',
        '',
        '**Q:** Which mites did you count?',
        '**A:** Varroa mites, once a month.',
    ]);
    const word = await upload(docx);
    assertEq(word.status, 201, 'uploading a Word file');
    assertEq(word.body.error, null);
    assertEq(word.body.preparedCount, 2);
    const wordText = (await backend.call('GET', `${base}/materials/${word.body.id}`, token)).body.text as string;
    assertTextContains(wordText, /Every week, on a platform scale/);
    const pdf = makePdf(cue.path('files', 'summary.pdf'), [
        'Rooftop colonies made 31 kg of honey per hive.',
        'Winter losses were 9 percent.',
    ]);
    const pdfMaterial = await upload(pdf);
    assertEq(pdfMaterial.status, 201, 'uploading a PDF');
    assertTextContains((await backend.call('GET', `${base}/materials/${pdfMaterial.body.id}`, token)).body.text, /31 kg of honey/);
    assertEq(pdfMaterial.body.summary, '14 words');

    const asked = cue.serviceRequests('markdown-request');
    assertDeepEq(
        asked.map((request) => request.name),
        ['prepared.docx', 'summary.pdf'],
        'only Word and PDF files go to toMarkdown',
    );
    assertTextContains(asked[0]!.contentType, /wordprocessingml/);
    assertEq(asked[1]?.contentType, 'application/pdf');
    assertEq(asked[1]?.bytes, statSync(pdf).size, 'the whole file reached it');

    const prepared = await answers();
    const fromWord = prepared.filter((item) => item.materialId === word.body.id);
    assertDeepEq(
        fromWord.map((item) => [item.question, item.who]),
        [
            ['How were the hives weighed?', 'Smith'],
            ['Which mites did you count?', null],
        ],
    );
    assertEq(fromWord[1]?.answer, 'Varroa mites, once a month.');

    // Slides: the text of each, and the speaker notes are where the prepared answers are.
    const deck = makePptx(cue.path('files', 'deck.pptx'), [
        { title: 'Rooftop bees', body: '48 hives' },
        { title: 'Results', notes: ['Q: What was the yield?', 'A: 31 kg per hive.'] },
    ]);
    const slides = await upload(deck);
    assertEq(slides.status, 201, 'uploading slides');
    assertEq(slides.body.summary, '2 slides · 1 prepared answers');
    const slideText = (await backend.call('GET', `${base}/materials/${slides.body.id}`, token)).body.text as string;
    assertTextContains(slideText, /^### Slide 2$/);
    assertTextContains(slideText, /^Speaker notes:$/);
    assertTextNotContains(slideText, /^9$/);
    assertEq((await answers()).find((item) => item.materialId === slides.body.id)?.source, 'deck.pptx, slide 2 notes');
    assertEq(cue.serviceRequests('markdown-request').length, 2, 'slides do not go to toMarkdown');

    // A PDF with no text keeps its place in the list, with the reason.
    const scanned = await upload(makePdf(cue.path('files', 'scan.pdf'), []));
    assertEq(scanned.status, 201);
    assertEq(scanned.body.error, 'No text in this PDF (scanned?)');
    assertEq(scanned.body.summary, '');
    assertEq(
        (await answers()).some((item) => item.materialId === scanned.body.id),
        false,
    );

    // Not a file Cue reads.
    const refused = await upload(writeFile(cue.path('files', 'tool.exe'), 'MZ'));
    assertEq(refused.status, 400, 'a file Cue cannot read');
    assertTextContains(refused.body.error.message, /\.exe/);

    // The list is by name; the originals are in R2; Workers AI's use is recorded.
    const listed = (await backend.call('GET', `${base}/materials`, token)).body.materials as Material[];
    assertDeepEq(
        listed.map((item) => item.name),
        ['deck.pptx', 'prepared.docx', 'scan.pdf', 'summary.pdf', 'talk 2.md', 'talk.md'],
    );
    assertEq((await backend.call('GET', `/v1/projects/${project.id}`, token)).body.materialCount, 6);
    const usage = await backend.rows(
        "SELECT feature, provider, model, units, unit, cost_micros FROM usage WHERE feature = 'material_text'",
    );
    assertEq(usage.length, 2, 'one row of usage for each file toMarkdown read');
    assertEq(String(usage[0]?.provider), 'cloudflare');
    assertEq(String(usage[0]?.unit), 'files');

    // Prepared answers follow the project's language: Ukrainian labels count once the project is Ukrainian... and English ones still do.
    await upload(writeFile(cue.path('files', 'uk.md'), 'Питання: Скільки було вуликів?\nВідповідь: Сорок вісім.\n'));
    assertEq(
        (await answers()).some((item) => item.answer === 'Сорок вісім.'),
        false,
        'Ukrainian labels are not read in an English project',
    );
    await backend.call('PATCH', base, token, { body: { language: 'uk' } });
    assertEq(
        (await answers()).find((item) => item.answer === 'Сорок вісім.')?.question,
        'Скільки було вуликів?',
        'they are once the project is Ukrainian',
    );
    assertEq((await answers()).length, 4 + 2 + 1 + 1, 'and the English ones still are');

    // Removing a file.
    assertEq(backend.objects().length, 7, 'the originals are in R2');
    assertEq((await backend.call('DELETE', `${base}/materials/${talk.body.id}`, token)).status, 200);
    assertEq((await backend.call('GET', `${base}/materials/${talk.body.id}`, token)).status, 404, 'the removed file is gone');
    assertEq(
        (await answers()).some((item) => item.source === 'talk.md'),
        false,
        'and so are its prepared answers',
    );
    assertEq(
        ((await backend.call('GET', `${base}/materials`, token)).body.materials as Material[]).length,
        6,
        'five left, and the Ukrainian one',
    );
    assertEq(backend.objects().length, 6, 'the original of the removed file is gone from R2');

    // Deleting the project takes the rest with it.
    assertEq((await backend.call('DELETE', base, token)).status, 200);
    assertEq(backend.objects().length, 0, "the project's files are gone from R2");
    assertEq(Number((await backend.rows('SELECT COUNT(*) AS n FROM material'))[0]?.['n']), 0, 'and from the database');
});
