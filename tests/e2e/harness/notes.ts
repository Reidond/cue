// Reading a note Cue wrote: its summary, and who its transcript says said each line of a dialogue.
import { lines } from './files.ts';

/** A note's summary: from its title to the transcript marker (without the marker), as text. */
export function summaryOf(notes: string): string {
    // As `sed -n '/^# /,/^<!-- transcript -->$/p' | sed '$d'`: every range from a title line to the marker.
    const kept: string[] = [];
    let inside = false;
    for (const line of lines(notes)) {
        if (inside) {
            kept.push(line);
            if (line === '<!-- transcript -->') inside = false;
        } else if (line.startsWith('# ')) {
            kept.push(line);
            inside = true;
        }
    }
    kept.pop();
    return kept.map((line) => `${line}\n`).join('');
}

function seconds(time: string): number {
    const [hours = 0, minutes = 0, secs = 0] = time.split(':').map(Number);
    return hours * 3600 + minutes * 60 + secs;
}

/**
 * Who the transcript says said each line of a dialogue: for every line of its timeline.tsv, the
 * voice and the label of the transcript turn that starts with it (within 2 s, or "?"), as
 * tab-separated lines: `Karen	Participant 2`.
 */
export function turnSpeakers(notes: string, timeline: string): string {
    const turns = lines(notes).flatMap((line) => {
        const turn = /^\*\*([0-9]{2}:[0-9]{2}:[0-9]{2}) · (.+)\*\*$/.exec(line);
        return turn ? [{ time: seconds(turn[1] ?? ''), label: turn[2] ?? '' }] : [];
    });
    return lines(timeline)
        .map((row) => {
            const [start = '', , , voice = ''] = row.split('\t');
            let best = '?',
                nearest = 2;
            for (const turn of turns) {
                const distance = Math.abs(Number(start) - turn.time);
                if (distance <= nearest) [nearest, best] = [distance, turn.label];
            }
            return `${voice}\t${best}\n`;
        })
        .join('');
}

/** The labels `turnSpeakers` found for a voice, sorted, each once, comma-separated. */
export function labelsOf(speakers: string, voice: string): string {
    const labels = speakers.split('\n').flatMap((row) => {
        const [rowVoice, label] = row.split('\t');
        return rowVoice === voice && label !== undefined ? [label] : [];
    });
    return [...new Set(labels)].sort().join(',');
}

/** Where the timeline puts each line, and where the stand-in heard speech in the audio the backend sent it: to read when the two differ. */
export function heardReport(timeline: string, heard: { side: string; seconds: number; heard: [number, number][] }[]): string {
    const fixed = (value: number) => value.toFixed(2);
    const placed = lines(timeline).map((row) => row.split('\t').slice(0, 4).join(' '));
    return [
        `timeline: ${placed.join(' | ')}`,
        ...heard.map((request) => {
            const stretches = request.heard.map(([from, to]) => `${fixed(from)}-${fixed(to)}`).join(' ');
            return `${request.side} (${fixed(request.seconds)} s): ${stretches}`;
        }),
    ].join('\n');
}
