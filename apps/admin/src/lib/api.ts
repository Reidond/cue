import { treaty } from '@elysiajs/eden';
import type { App } from 'api';

// Same origin as the Worker that serves this page, and the session cookie goes with every request. The types are the Worker's own: Eden reads
// them off the Elysia app, so a route or a schema that changes there is a type error here. Eden would turn a string that looks like a date
// ("2026-10-01", a day of the chart) into a Date; the schema says string, so it stays one.
export const api = treaty<App>(location.origin, { parseDate: false }).admin.v1;

/** A request the admin API refused or that did not arrive. `code` is the API's error code when it sent one. */
export class ApiFailure extends Error {
    readonly status: number;
    readonly code: string | undefined;

    constructor(status: number, code: string | undefined, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

interface Settled<Data> {
    data: Data | null;
    error: { status: unknown; value: unknown } | null;
    status: number;
}

/** The data of an Eden call, or an `ApiFailure` carrying the API's own message (`{error: {code, message}}`). */
export async function unwrap<Data>(request: Promise<Settled<Data>>): Promise<Data> {
    const result = await request.catch(() => {
        throw new ApiFailure(0, undefined, 'The admin could not be reached. Check the connection and try again.');
    });
    if (result.error || result.data === null) {
        const body = (result.error?.value ?? null) as { error?: { code?: string; message?: string } } | null;
        throw new ApiFailure(result.status, body?.error?.code, body?.error?.message ?? 'Something went wrong. Try again.');
    }
    return result.data;
}
