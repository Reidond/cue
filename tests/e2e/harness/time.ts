// Times for the calendar a case gives Cue, and waiting.
import { setTimeout } from 'node:timers/promises';

export function sleep(seconds: number): Promise<void> {
    return setTimeout(seconds * 1000);
}

/** Whether `promise` settles within `seconds` (its timer doesn't outlive it). */
export async function within(promise: Promise<unknown>, seconds: number): Promise<boolean> {
    const timer = new AbortController();
    const timedOut = setTimeout(seconds * 1000, false, { signal: timer.signal }).catch(() => false);
    const settled = await Promise.race([promise.then(() => true, () => true), timedOut]);
    timer.abort();
    return settled;
}

/** ISO 8601 in UTC to the second, as calendar events have it: 2026-10-25T09:30:00Z. */
function iso(date: Date): string {
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The time `minutes` from now (negative: ago). */
export function minutesFromNow(minutes: number): string {
    return iso(new Date(Date.now() + minutes * 60_000));
}

/** That local time tomorrow, by the calendar: a day is not always 24 hours (DST). `tomorrowAt('10:00')` */
export function tomorrowAt(time: string): string {
    const [hours, minutes] = time.split(':').map(Number);
    const date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(hours ?? 0, minutes ?? 0, 0, 0);
    return iso(date);
}
