const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dollarsWhole = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const dollarsFine = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
});

/** US dollars: cents, or more digits when the amount is under a dollar's hundredth (a single cheap call). */
export function usd(amount: number): string {
    if (amount > 0 && amount < 0.01) return dollarsFine.format(amount);
    return dollars.format(amount);
}

/** Dollars without cents, for an axis or a round limit. */
export const usdWhole = (amount: number) => dollarsWhole.format(amount);

const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayName = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateTime = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' });
const date = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });

/** `2026-10` → "October 2026" (months are UTC, as the backend counts them). */
export const monthLabel = (month: string) => monthName.format(new Date(`${month}-01T00:00:00Z`));

/** `2026-10-14` → "Oct 14". */
export const dayLabel = (day: string) => dayName.format(new Date(`${day}T00:00:00Z`));

export const currentMonth = () => new Date().toISOString().slice(0, 7);

/** The month `by` months after `month`. */
export function shiftMonth(month: string, by: number): string {
    const [year = 0, number = 1] = month.split('-').map(Number);
    return new Date(Date.UTC(year, number - 1 + by, 1)).toISOString().slice(0, 7);
}

export const fullTime = (at: number) => dateTime.format(at);
export const fullDate = (at: number) => date.format(at);

const relative = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });

/** "3 hours ago", "yesterday"; for an absolute time use `fullTime`. */
export function ago(at: number, now = Date.now()): string {
    const seconds = Math.round((at - now) / 1000);
    const steps: [Intl.RelativeTimeFormatUnit, number][] = [
        ['day', 86400],
        ['hour', 3600],
        ['minute', 60],
    ];
    for (const [unit, size] of steps) {
        if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
    }
    return 'just now';
}

/** `live_transcript` → "Live transcript". */
export const featureName = (feature: string) => {
    const words = feature.replaceAll('_', ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
};
