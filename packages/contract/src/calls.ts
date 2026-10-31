import { type Static, Type } from '@sinclair/typebox';

// Live calls (`/v1/calls`, `/v1/live`, docs/backend.md): a call is one stretch of listening, from the client opening the microphone and the
// call audio to closing them. The Call Durable Object behind it hears the audio (Deepgram, one live stream per channel), spots the questions,
// matches prepared answers and answers with Claude; the client only streams audio and shows what the events say.
// Times in events are seconds since the call began; times in REST bodies are milliseconds since the epoch.

/** Which of the two audio sources a frame, a line or a command is about. `me` is the person's microphone, `others` the call's audio. */
export const Channel = Type.Union([Type.Literal('me'), Type.Literal('others')]);
export type Channel = Static<typeof Channel>;

/**
 * The audio the live socket takes: binary frames of one byte for the channel (`0` me, `1` others) followed by 16-bit little-endian PCM,
 * mono, at this rate. Frames of one channel are contiguous; a client sends silence rather than skipping it (the server's clock is the samples).
 */
export const AUDIO = { sampleRate: 16000, channelByte: { me: 0, others: 1 } } as const;

// MARK: REST

/** `POST /v1/calls`: starts a call for a project. The settings can be changed later with the socket's `config` command. */
export const NewCall = Type.Object({
    projectId: Type.String(),
    eventId: Type.Optional(Type.String({ description: "The calendar event the call is for, if any (kept with the call; PR 6's notes use it)" })),
    eventTitle: Type.Optional(Type.String()),
    ...{
        speaker: Type.Optional(Type.String({ description: 'The name the speaker goes by (empty: "the speaker")' })),
        auto: Type.Optional(Type.Boolean({ description: 'Answer the questions Cue notices by itself (default true); off: they wait for `prepare`' })),
        micQuestions: Type.Optional(Type.Boolean({ description: 'The microphone also hears the room: its lines can hold questions (default false)' })),
        questions: Type.Optional(Type.Boolean({ description: 'Look for questions at all (default true); off while a call is only being recorded' })),
    },
});
export type NewCall = Static<typeof NewCall>;

export const Call = Type.Object({
    callId: Type.String(),
    projectId: Type.String(),
    startedAt: Type.Number(),
});
export type Call = Static<typeof Call>;

export const CallId = Type.Object({ id: Type.String() });

/** `POST /v1/calls/:id/questions` (the Ask field): the answer comes back as server-sent events, and on the live socket too. */
export const AskBody = Type.Object({ text: Type.String({ minLength: 1, maxLength: 4000 }) });
export type AskBody = Static<typeof AskBody>;

/** `POST /v1/calls/:id/end`. */
export const CallEnded = Type.Object({ callId: Type.String(), lines: Type.Integer({ description: 'Final transcript lines kept with the call' }) });
export type CallEnded = Static<typeof CallEnded>;

/** `GET /v1/live?call=ID[&after=SEQ]`: the socket. Events after `after` that the server still has are sent again first. */
export const LiveQuery = Type.Object({ call: Type.String(), after: Type.Optional(Type.Integer({ minimum: 0 })) });

// MARK: Events, server to client (JSON text frames)

const Seq = Type.Integer({ description: 'Counts the call\'s events, 1, 2, …; a client that reconnects asks for what came after the last it saw' });

/** The first event of every connection. `resumed` when the client had been connected to this call before. */
export const ReadyEvent = Type.Object({ type: Type.Literal('ready'), seq: Seq, callId: Type.String(), resumed: Type.Boolean(), startedAt: Type.Number() });

/** What a part of the live path is doing; the client words its session log and status line from it. */
export const StatusEvent = Type.Object({
    type: Type.Literal('status'),
    seq: Seq,
    part: Type.Union([Type.Literal('speech'), Type.Literal('claude'), Type.Literal('judge')]),
    state: Type.Union([Type.Literal('starting'), Type.Literal('ready'), Type.Literal('unavailable')]),
    detail: Type.String({ description: 'For people: "Warming up Claude Sonnet…", why it is unavailable, …' }),
});

/** Someone started or stopped talking on a channel (Deepgram's voice activity), for the reading rules and the "Speaking" meters. */
export const SpeakingEvent = Type.Object({ type: Type.Literal('speaking'), seq: Seq, channel: Channel, active: Type.Boolean() });

const Line = {
    channel: Channel,
    speaker: Type.Union([Type.Integer(), Type.Null()], { description: 'Which voice on the call side (1, 2, …) when the recognizer told them apart; null otherwise' }),
    text: Type.String(),
    start: Type.Number(),
    end: Type.Number(),
};
/** The words so far of the utterance being said; replaced by the next partial and by the final. */
export const PartialEvent = Type.Object({ type: Type.Literal('transcript.partial'), seq: Seq, ...Line });
/** A finished utterance. A line the microphone only picked up from the speakers (an echo of the call) is not sent. */
export const FinalEvent = Type.Object({ type: Type.Literal('transcript.final'), seq: Seq, ...Line });

/** A question noticed (or asked), before any answer. Questions asked in one go share `exchange`. */
export const QuestionEvent = Type.Object({
    type: Type.Literal('question'),
    seq: Seq,
    id: Type.String(),
    exchange: Type.String(),
    index: Type.Integer({ description: 'Its place among the exchange\'s questions, from 0' }),
    of: Type.Integer({ description: 'How many questions the exchange has' }),
    text: Type.String(),
    opener: Type.Union([Type.String(), Type.Null()], { description: 'What to say right away, until the answer\'s first line is ready' }),
    requested: Type.Boolean({ description: 'An answer is being written; false with Auto off, until `prepare`' }),
    forced: Type.Boolean({ description: 'The person asked for it (the Ask field, answer now): show it at once' }),
});

/** The prepared answer that matches a question, found in the project's materials. */
export const PreparedEvent = Type.Object({
    type: Type.Literal('prepared'),
    seq: Seq,
    questionId: Type.String(),
    question: Type.String(),
    answer: Type.String(),
    who: Type.Union([Type.String(), Type.Null()]),
    source: Type.String(),
    score: Type.Number({ description: '0…1' }),
});

export const AnswerDeltaEvent = Type.Object({ type: Type.Literal('answer.delta'), seq: Seq, questionId: Type.String(), text: Type.String() });
export const AnswerDoneEvent = Type.Object({
    type: Type.Literal('answer.done'),
    seq: Seq,
    questionId: Type.String(),
    error: Type.Union([Type.String(), Type.Null()]),
});

/** Something went wrong with the call itself (not with one answer): a reason for people. `fatal` ends the socket. */
export const ErrorEvent = Type.Object({ type: Type.Literal('error'), seq: Seq, code: Type.String(), message: Type.String(), fatal: Type.Boolean() });

/** The call is over (ended with `POST …/end`, or timed out without a client). The server closes the socket after it. */
export const EndedEvent = Type.Object({ type: Type.Literal('ended'), seq: Seq, lines: Type.Integer() });

export const CallEvent = Type.Union([
    ReadyEvent,
    StatusEvent,
    SpeakingEvent,
    PartialEvent,
    FinalEvent,
    QuestionEvent,
    PreparedEvent,
    AnswerDeltaEvent,
    AnswerDoneEvent,
    ErrorEvent,
    EndedEvent,
]);
export type CallEvent = Static<typeof CallEvent>;

// MARK: Commands, client to server (JSON text frames)

/** The settings of the call that can change while it runs. */
export const ConfigCommand = Type.Object({
    type: Type.Literal('config'),
    speaker: Type.Optional(Type.String()),
    auto: Type.Optional(Type.Boolean()),
    micQuestions: Type.Optional(Type.Boolean()),
    questions: Type.Optional(Type.Boolean()),
});
/** The Ask field: answers `text` now, as an exchange of its own. */
export const AskCommand = Type.Object({ type: Type.Literal('ask'), text: Type.String({ minLength: 1 }) });
/** The "answer now" hot key: what the others are saying right now, else their last line; its questions are answered each on its own. */
export const AnswerNowCommand = Type.Object({ type: Type.Literal('answerNow') });
/** Prepare Answer on an exchange noticed with Auto off. */
export const PrepareCommand = Type.Object({ type: Type.Literal('prepare'), exchange: Type.String() });

export const CallCommand = Type.Union([ConfigCommand, AskCommand, AnswerNowCommand, PrepareCommand]);
export type CallCommand = Static<typeof CallCommand>;

// MARK: Summaries (temporary)

/**
 * `POST /v1/summaries`: until PR 6's notes Workflow, the Mac builds the summary prompt itself and has the backend run it (so the keys stay here).
 * The reply is server-sent events: `delta` `{text}` pieces, then `done` `{}`, or `error` `{message}`.
 */
export const SummaryBody = Type.Object({
    system: Type.String({ minLength: 1, maxLength: 200000 }),
    transcript: Type.String({ minLength: 1, maxLength: 2000000 }),
});
export type SummaryBody = Static<typeof SummaryBody>;
