// Server-sent events as the apps read them (the notes' progress, the brief while it is written): a response read to its end, event by event.

/** One event as it arrived: its name (`message` when it has none), its data parsed, and when it came (ms since the epoch). */
export interface ServerSentEvent {
    event: string;
    data: unknown;
    at: number;
}

/** Reads a `text/event-stream` response until the server ends it. */
export async function serverSentEvents(response: Response): Promise<ServerSentEvent[]> {
    const events: ServerSentEvent[] = [];
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const fields = buffer.slice(0, end).split('\n');
            buffer = buffer.slice(end + 2);
            const event =
                fields
                    .find((line) => line.startsWith('event:'))
                    ?.slice(6)
                    .trim() ?? 'message';
            const data = fields
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trimStart())
                .join('\n');
            if (data !== '') events.push({ event, data: JSON.parse(data), at: Date.now() });
        }
    }
    return events;
}
