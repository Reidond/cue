/* oxlint-disable jsx-a11y/prefer-tag-over-role -- the chart is read with the arrow keys like a slider, but it is not a native range input */
import type { DayUsage } from '@cue/contract';
import { useState } from 'react';
import { dayLabel, usd, usdWhole } from '../lib/format.ts';

/** The nicest round number at or above `value`: 1, 2, 5, 10, 20, 50, … */
function niceMax(value: number): number {
    if (value <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(value));
    return ([1, 2, 5, 10].find((step) => step * magnitude >= value) ?? 10) * magnitude;
}

/**
 * Spend per day as bars. One series, one hue; the numbers are in the readout (hover, or ← → on the chart) and in the table underneath, so
 * nothing depends on seeing the bars.
 */
export function DayChart({ days, title }: { days: DayUsage[]; title: string }) {
    const [active, setActive] = useState<number | null>(null);
    const max = niceMax(Math.max(0, ...days.map((day) => day.usd)));
    const total = days.reduce((sum, day) => sum + day.usd, 0);
    const shown = active === null ? undefined : days[active];
    const last = days.length - 1;

    function onKeyDown(event: React.KeyboardEvent) {
        const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1 };
        if (event.key === 'Home' || event.key === 'End') setActive(event.key === 'Home' ? 0 : last);
        else if (moves[event.key] !== undefined)
            setActive(Math.min(last, Math.max(0, (active ?? (moves[event.key]! > 0 ? -1 : last + 1)) + moves[event.key]!)));
        else if (event.key === 'Escape') setActive(null);
        else return;
        event.preventDefault();
    }

    return (
        <div>
            <div
                className="chart"
                role="slider"
                aria-roledescription="chart"
                aria-label={`${title}: ${usd(total)} in ${days.length} days. Use the arrow keys to read each day.`}
                aria-orientation="horizontal"
                aria-valuemin={0}
                aria-valuemax={last}
                aria-valuenow={active ?? 0}
                aria-valuetext={shown ? `${dayLabel(shown.date)}: ${usd(shown.usd)}` : 'No day selected'}
                tabIndex={0}
                data-active={active === null ? undefined : ''}
                onKeyDown={onKeyDown}
                onBlur={() => setActive(null)}
                onPointerLeave={() => setActive(null)}
            >
                <div className="chart-readout num" aria-live="polite">
                    {shown ? (
                        <>
                            <span>{dayLabel(shown.date)}</span>
                            <strong>{usd(shown.usd)}</strong>
                        </>
                    ) : (
                        <span>{total > 0 ? 'Hover or use the arrow keys to read a day' : 'No spend yet this month'}</span>
                    )}
                </div>
                <div className="chart-plot">
                    <div className="chart-grid" aria-hidden="true">
                        <i style={{ top: 0 }} />
                        <i style={{ top: '50%' }} />
                    </div>
                    <span className="chart-scale num" aria-hidden="true">
                        {usdWhole(max)}
                    </span>
                    {days.map((day, index) => (
                        <div
                            key={day.date}
                            className="chart-col"
                            data-active={active === index ? '' : undefined}
                            onPointerEnter={() => setActive(index)}
                        >
                            <div
                                className="chart-bar"
                                data-zero={day.usd === 0 ? '' : undefined}
                                style={{ height: `${(day.usd / max) * 100}%` }}
                            />
                        </div>
                    ))}
                </div>
                <div className="chart-axis num" aria-hidden="true">
                    <span>{days[0] ? dayLabel(days[0].date) : ''}</span>
                    <span>{days[last] ? dayLabel(days[last].date) : ''}</span>
                </div>
            </div>
            <details className="table-view">
                <summary>Show as a table</summary>
                <table className="num">
                    <caption className="sr-only">{title}</caption>
                    <tbody>
                        {days.map((day) => (
                            <tr key={day.date}>
                                <td>{dayLabel(day.date)}</td>
                                <td>{usd(day.usd)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </details>
        </div>
    );
}
