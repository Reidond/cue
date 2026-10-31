import namesTemplate from '../../prompts/names.md?raw';
import summaryTemplate from '../../prompts/summary.md?raw';

// The prompts that turn a transcript into notes. The port of the Mac app's `Summarizer.systemPrompt`, now two: the summary, and the names of
// the people on the call (which the Mac app asked for in the same request).

export interface Meeting {
    title: string;
    attendees: string[];
}

export interface PromptContext {
    /** The label of the person who recorded the call, as the transcript has it. */
    speaker: string;
    /** The labels of the others: one for everyone else, or one per voice told apart. */
    others: string[];
    /** Those of them that are labels rather than names: the model may suggest who they are. */
    unnamed: string[];
    language: string;
    occasion: string;
    namesAndTerms: string;
    meeting: Meeting | null;
}

const labels = (names: string[]) => {
    const listed = names.map((name) => `[${name}]`);
    return listed.length > 1 ? `${listed.slice(0, -1).join(', ')} and ${listed.at(-1)}` : listed.join('');
};

const event = (meeting: Meeting | null) =>
    meeting
        ? `\n\nThe call was the calendar event “${meeting.title}”.${meeting.attendees.length > 0 ? ` Invited: ${meeting.attendees.join(', ')}.` : ''} The transcript doesn't say which of them is speaking: use a name only where the conversation makes it clear (for example, someone is addressed by name).`
        : '';

export function summaryPrompt(context: PromptContext): string {
    const terms = context.namesAndTerms.trim();
    const people =
        context.others.length > 1
            ? `${labels(context.others)} are the other people on the call, told apart by their voices (now and then a line may go to the wrong one)`
            : 'the other label is everyone else, possibly several people';
    const naming =
        context.unnamed.length === 0
            ? ''
            : `\n\nIn the notes, write the other people on the call by their label exactly as in the transcript (${labels(context.unnamed)}), without brackets and without inflecting it, so it can be replaced with a name later.`;
    return summaryTemplate
        .replaceAll('{{speaker}}', context.speaker === '' ? 'the user' : context.speaker)
        .replaceAll('{{people}}', people)
        .replaceAll('{{language}}', context.language)
        .replaceAll('{{occasion}}', context.occasion.trim() === '' ? 'none' : context.occasion.trim())
        .replaceAll('{{terms}}', terms === '' ? '' : `\n\nNames and terms that may come up, spelled the way the user writes them: ${terms}`)
        .replaceAll('{{event}}', event(context.meeting))
        .replaceAll('{{labels}}', naming);
}

export function namesPrompt(context: PromptContext): string {
    return namesTemplate
        .replaceAll('{{speaker}}', context.speaker === '' ? 'the user' : context.speaker)
        .replaceAll('{{labels}}', labels(context.unnamed))
        .replaceAll('{{event}}', event(context.meeting))
        .replaceAll('{{example}}', context.unnamed[0] ?? 'Participant 1');
}
