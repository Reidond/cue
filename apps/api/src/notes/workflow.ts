import { env, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { describe, send, stream } from '../call/anthropic.ts';
import { lexiconFor } from '../call/lexicon.ts';
import { ANSWER_MODEL, noThinking, type Tokens, type UsageRow } from '../call/models.ts';
import { speechUsage, tokenUsage } from '../pricing.ts';
import { limitState, recordUsage } from '../usage.ts';
import { participantsOf, turnsFor, userLabel } from './compose.ts';
import { transcribe } from './deepgram.ts';
import { janitor } from './janitor.ts';
import { noteLexicon } from './lexicon.ts';
import { addEvent, type AudioKeys, linesOf, loadNote, type NoteRow, parse, setStep, type StepId, voicesOf } from './store.ts';
import { type Meeting, namesPrompt, type PromptContext, summaryPrompt } from './summary.ts';
import {
    droppingTranscriptRemarks,
    labelsOf,
    labelVoices,
    length,
    nameSuggestions,
    plainText,
    sideLost,
    titleOf,
    withoutEchoes,
    withoutTitle,
} from './transcript.ts';

export interface NotesParams {
    noteId: string;
}

/** Seconds a failed step waits before trying again; a case shortens it. */
const retryDelay = () => {
    const seconds = Number(env.NOTES_RETRY_SECONDS);
    return `${Number.isFinite(seconds) && seconds > 0 ? seconds : 5} seconds` as const;
};

const took = (since: number) => ((Date.now() - since) / 1000).toFixed(1);

/** A failure's reason as a session-log line has it: no full stop at the end. */
const reasonOf = (error: unknown) => {
    const message = error instanceof Error && error.message !== '' ? error.message : describe(error);
    // A step that gave up for good arrives as "NonRetryableError: the reason".
    return message.replace(/^NonRetryableError:\s*/, '').replace(/[. ]+$/, '');
};

/** What a step says about itself while it runs and when it fails; `kept` is what the note keeps then. */
interface StepText {
    start: string | null;
    failed: (why: string) => string;
    kept: string;
}

const TEXT: Record<StepId, StepText> = {
    transcript: {
        start: '🔁 Improving transcript…',
        failed: (why) => `⚠︎ Couldn't improve the transcript: ${why} — the live transcript is kept`,
        kept: 'The live transcript is kept.',
    },
    speakers: {
        start: '👥 Finding speakers…',
        failed: (why) => `⚠︎ Couldn't tell speakers apart: ${why} — the transcript is kept as it was`,
        kept: 'The transcript is kept as it was.',
    },
    names: { start: null, failed: (why) => `⚠︎ Couldn't suggest names: ${why}`, kept: '' },
    summary: { start: '✍️ Writing summary…', failed: (why) => `⚠︎ Summary failed: ${why}`, kept: '' },
};

/** What a step did not do when the month's allowance was used up (the session log's `⚠︎ Cue plan limit reached: …`). */
const LIMITED: Record<StepId, string> = {
    transcript: "the transcript wasn't improved — the live transcript is kept",
    speakers: "the speakers weren't told apart — the transcript is kept as it was",
    names: "no names were suggested",
    summary: "the summary wasn't written — the transcript is kept",
};

/**
 * The notes pipeline: transcribe each side of the recording again, tell the voices on the call side apart, suggest names for them, write the
 * summary, store the note. Each step is retried on its own, and one that fails for good never stops the others: the note keeps what it had
 * (the live transcript, the transcript as it was) and says what failed. Every step writes its progress to D1, which clients follow.
 * Only note ids go between steps: the transcript lives in D1 (a step's result is limited to 1 MiB).
 */
export class NotesWorkflow extends WorkflowEntrypoint<Env, NotesParams> {
    async run(event: Readonly<WorkflowEvent<NotesParams>>, step: WorkflowStep) {
        const { noteId } = event.payload;
        const db = this.env.DB;
        const config = { retries: { limit: 3, delay: retryDelay(), backoff: 'constant' }, timeout: '10 minutes' } as const;

        // `costs`: whether the step spends money for this note; one that does not run once the person's month is used up is marked failed with
        // the limit as the reason (the recording and the live transcript were saved before: they are not touched).
        const guarded = async (id: StepId, work: (note: NoteRow) => Promise<string | null>, costs: (note: NoteRow) => boolean = () => true) => {
            const note = await loadNote(db, noteId);
            if (!parse<{ id: StepId }[]>(note.steps, []).some((candidate) => candidate.id === id)) return;
            if (costs(note) && (await step.do(`${id} limit`, async () => (await limitState(db, note.user_id)).over))) {
                await step.do(`${id} limited`, async () => {
                    const kept = TEXT[id].kept;
                    await setStep(db, noteId, id, 'failed', `Cue plan limit reached. ${kept}`.trim(), `⚠︎ Cue plan limit reached: ${LIMITED[id]}`);
                });
                return;
            }
            try {
                await step.do(id, config, async (context) => {
                    // A retry says nothing new: the line is written once.
                    if (context.attempt === 1) await setStep(db, noteId, id, 'running', null, TEXT[id].start);
                    const detail = await work(await loadNote(db, noteId));
                    // The step's closing line (`✅ …`) was written by `work` when it has one.
                    await setStep(db, noteId, id, 'done', detail);
                });
            } catch (error) {
                const why = reasonOf(error);
                await step.do(`${id} failed`, async () => {
                    const text = TEXT[id];
                    await setStep(db, noteId, id, 'failed', text.kept === '' ? why : `${why}. ${text.kept}`, text.failed(why));
                });
            }
        };

        await guarded('transcript', (note) => improveTranscript(db, note));
        await guarded(
            'speakers',
            (note) => findSpeakers(db, note),
            // The voices come from the second pass; without it the call side is read again, which costs.
            (note) => voicesOf(note) === null && linesOf(note).some((line) => line.channel === 'others'),
        );
        await guarded('names', (note) => suggestNames(db, note));
        await guarded('summary', (note) => writeSummary(db, note));
        await step.do('store', config, async () => {
            const note = await loadNote(db, noteId);
            const keys = parse<AudioKeys>(note.audio, {});
            const statements = [db.prepare("UPDATE note SET status = 'ready', ready_at = ? WHERE id = ?").bind(Date.now(), noteId)];
            // Keep audio is off: nothing of the recording stays.
            if (note.keep_audio === 0 && Object.keys(keys).length > 0) {
                await Promise.all(Object.values(keys).map((key) => env.RECORDINGS.delete(key)));
                statements.push(db.prepare("UPDATE note SET audio = '{}', audio_deleted_at = ? WHERE id = ?").bind(Date.now(), noteId));
            }
            await db.batch(statements);
            await addEvent(db, noteId, { kind: 'note', state: 'ready' });
            await janitor().ensure();
        });
        return { noteId };
    }
}

async function project(db: D1Database, note: NoteRow) {
    const row = note.project_id
        ? await db
              .prepare('SELECT occasion, names_and_terms FROM project WHERE id = ?')
              .bind(note.project_id)
              .first<{ occasion: string; names_and_terms: string }>()
        : null;
    return { occasion: row?.occasion ?? '', namesAndTerms: row?.names_and_terms ?? '' };
}

const usage = (note: NoteRow, db: D1Database, rows: UsageRow[]) => recordUsage(db, note.user_id, rows);

/** Speech recognition's rows: the audio Deepgram heard, per side. */
const speechRows = (seconds: Record<string, number>): UsageRow[] =>
    Object.entries(seconds)
        .filter(([, value]) => value > 0)
        .map(([side, value]) => speechUsage('note_transcript', 'recorded', `nova-3:${side}`, value));

async function audioOf(note: NoteRow, side: 'me' | 'others'): Promise<R2ObjectBody> {
    const key = parse<AudioKeys>(note.audio, {})[side];
    const object = key ? await env.RECORDINGS.get(key) : null;
    if (!object) throw new NonRetryableError(`the ${side === 'me' ? 'microphone' : 'call'} recording is missing`);
    return object;
}

/** The second pass: Deepgram reads each side's whole recording; its utterances replace the live transcript. */
async function improveTranscript(db: D1Database, note: NoteRow): Promise<string | null> {
    const started = Date.now();
    const { namesAndTerms } = await project(db, note);
    const language = note.spoken_language ?? note.language;
    const options = { language, namesAndTerms };
    // Each side's audio is billed as soon as Deepgram has read it, so one side failing does not lose the other's usage.
    const side = async (which: 'me' | 'others') => {
        const read = await transcribe(await audioOf(note, which), which, options);
        await usage(note, db, speechRows({ [which]: read.seconds }));
        return read;
    };
    const [me, others] = await Promise.all([side('me'), side('others')]);
    const lines = withoutEchoes([...me.lines, ...others.lines], lexiconFor(language).stopWords).toSorted((a, b) => a.start - b.start);
    if (lines.length === 0) throw new NonRetryableError('Deepgram found no speech in the call’s audio');
    const lost = sideLost(linesOf(note), lines);
    if (lost) throw new NonRetryableError(`it heard much less than live recognition on ${lost}`);

    const lexicon = noteLexicon(note.language);
    await db
        .prepare('UPDATE note SET lines = ?, voices = ?, transcript = ?, participants = ? WHERE id = ?')
        .bind(
            JSON.stringify(lines),
            JSON.stringify(others.voices),
            JSON.stringify(turnsFor(lexicon, note.speaker, lines)),
            JSON.stringify(participantsOf(lexicon, note.speaker, lines)),
            note.id,
        )
        .run();
    const audio = Math.max(me.seconds, others.seconds);
    await addEvent(db, note.id, {
        kind: 'step',
        step: 'transcript',
        state: 'running',
        line: `✅ Transcript improved: ${lines.length} segments (${took(started)} s for ${length(audio)} of audio)`,
    });
    return null;
}

/** Tells the voices on the call side apart and gives each call-side line its voice: numbered in the order they first speak. */
async function findSpeakers(db: D1Database, note: NoteRow): Promise<string | null> {
    const started = Date.now();
    const lines = linesOf(note);
    if (!lines.some((line) => line.channel === 'others')) {
        await addEvent(db, note.id, {
            kind: 'step',
            step: 'speakers',
            state: 'running',
            line: '✅ Speakers: 0 (no one spoke on the call side)',
        });
        return 'No one else spoke';
    }
    let voices = voicesOf(note);
    if (voices === null) {
        // The second pass did not run: the call side is read again, only for who spoke when.
        const { namesAndTerms } = await project(db, note);
        const read = await transcribe(await audioOf(note, 'others'), 'others', {
            language: note.spoken_language ?? note.language,
            namesAndTerms,
        });
        await usage(note, db, speechRows({ others: read.seconds }));
        voices = read.voices;
    }
    const { lines: labelled, count } = labelVoices(lines, voices);
    if (count > 1) {
        const lexicon = noteLexicon(note.language);
        await db
            .prepare('UPDATE note SET lines = ?, transcript = ?, participants = ? WHERE id = ?')
            .bind(
                JSON.stringify(labelled),
                JSON.stringify(turnsFor(lexicon, note.speaker, labelled)),
                JSON.stringify(participantsOf(lexicon, note.speaker, labelled)),
                note.id,
            )
            .run();
    }
    await addEvent(db, note.id, {
        kind: 'step',
        step: 'speakers',
        state: 'running',
        line: `✅ Speakers: ${count} (${took(started)} s, ${voices.length} stretches of speech)`,
    });
    return count > 1 ? `${count} people on the call` : 'One person on the call';
}

async function context(db: D1Database, note: NoteRow): Promise<PromptContext> {
    const lexicon = noteLexicon(note.language);
    const participants = parse<string[]>(note.participants, []);
    const { occasion, namesAndTerms } = await project(db, note);
    return {
        speaker: participants[0] ?? userLabel(note.speaker),
        others: participants.slice(1),
        unnamed: labelsOf(lexicon, participants),
        language: lexiconFor(note.language).name,
        occasion,
        namesAndTerms,
        meeting: parse<Meeting | null>(note.meeting, null),
    };
}

const transcriptOf = (note: NoteRow) => plainText(parse(note.transcript, []));

/** The model's idea of who the unnamed people on the call are: names for their labels, from what is said. */
async function suggestNames(db: D1Database, note: NoteRow): Promise<string | null> {
    const prompt = await context(db, note);
    const transcript = transcriptOf(note);
    if (prompt.unnamed.length === 0 || transcript.trim() === '') return null;
    const { text, tokens } = await send({
        model: ANSWER_MODEL,
        max_tokens: 1024,
        thinking: noThinking(ANSWER_MODEL),
        system: namesPrompt(prompt),
        messages: [{ role: 'user', content: `Transcript:\n\n${transcript}` }],
    });
    await usage(note, db, tokenUsage('note_names', ANSWER_MODEL, tokens));
    const { names } = nameSuggestions(text, prompt.unnamed);
    await db.prepare('UPDATE note SET suggestions = ? WHERE id = ?').bind(JSON.stringify(names), note.id).run();
    return null;
}

/** The summary: Claude writes it from the transcript; its title names the note unless it was a calendar event. */
async function writeSummary(db: D1Database, note: NoteRow): Promise<string | null> {
    const prompt = await context(db, note);
    const transcript = transcriptOf(note);
    if (transcript.trim() === '') return null;
    let result: Awaited<ReturnType<typeof stream>>;
    try {
        // Claude may think first (the default): nobody waits on the first word here.
        result = await stream(
            {
                model: ANSWER_MODEL,
                max_tokens: 16000,
                system: summaryPrompt(prompt),
                messages: [{ role: 'user', content: `Transcript:\n\n${transcript}` }],
            },
            () => {},
        );
    } catch (error) {
        const tokens = (error as { tokens?: Tokens }).tokens;
        if (tokens) await usage(note, db, tokenUsage('notes_summary', ANSWER_MODEL, tokens));
        throw new Error(describe(error));
    }
    await usage(note, db, tokenUsage('notes_summary', ANSWER_MODEL, result.tokens));

    // Remarks about the transcript break the rule in the prompt; the lexicon says how they read.
    const { text: cleaned, dropped } = droppingTranscriptRemarks(result.text, noteLexicon(note.language).remarkWords);
    for (const remark of dropped) {
        await addEvent(db, note.id, {
            kind: 'step',
            step: 'summary',
            state: 'running',
            line: `🧽 Dropped a remark about the transcript from the summary: ${remark}`,
        });
    }
    // A model that named people in the summary itself still gets them suggested.
    const { text: summary, names: inSummary } = nameSuggestions(cleaned, prompt.unnamed);
    const suggestions = { ...inSummary, ...parse<Record<string, string>>(note.suggestions, {}) };
    // A calendar call keeps the event's title; other calls take the summary's.
    const title = prompt.meeting ? note.title : (titleOf(summary) ?? note.title);
    await db
        .prepare('UPDATE note SET summary = ?, title = ?, suggestions = ? WHERE id = ?')
        .bind(withoutTitle(summary), title, JSON.stringify(suggestions), note.id)
        .run();
    for (const [label, name] of Object.entries(suggestions).toSorted(([a], [b]) => a.localeCompare(b))) {
        await addEvent(db, note.id, {
            kind: 'suggestion',
            step: 'summary',
            state: 'running',
            line: `💡 Suggested name: ${label} → ${name}`,
        });
    }
    return null;
}
