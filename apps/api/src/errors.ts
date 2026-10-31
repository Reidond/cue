import { type ErrorCode, errorStatus } from '@cue/contract';

/** Thrown by routes and mapped to `{error: {code, message, retryable}}` by the app's `onError`. */
export class ApiError extends Error {
    readonly code: ErrorCode;
    readonly retryable: boolean;

    constructor(code: ErrorCode, message: string, retryable = false) {
        super(message);
        this.code = code;
        this.retryable = retryable;
    }
}

export function errorResponse(code: ErrorCode, message: string, retryable = false, headers?: HeadersInit): Response {
    return Response.json({ error: { code, message, retryable } }, { status: errorStatus[code], headers });
}
