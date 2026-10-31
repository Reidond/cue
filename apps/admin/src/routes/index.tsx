import type { Overview } from '@cue/contract';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ChevronLeft, ChevronRight } from '../components/icons.tsx';
import { DayChart } from '../components/DayChart.tsx';
import { EmptyState, ErrorState, Meter, Skeleton } from '../components/ui.tsx';
import { currentMonth, featureName, monthLabel, shiftMonth, usd } from '../lib/format.ts';
import { overviewQuery } from '../lib/queries.ts';

export const Route = createFileRoute('/')({
    validateSearch: (search: Record<string, unknown>): { month?: string } => ({
        month: typeof search['month'] === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(search['month']) ? search['month'] : undefined,
    }),
    loaderDeps: ({ search }) => ({ month: search.month }),
    loader: ({ context, deps }) => {
        void context.queryClient.prefetchQuery(overviewQuery(deps.month));
    },
    component: OverviewPage,
});

function OverviewPage() {
    const { month } = Route.useSearch();
    const overview = useQuery(overviewQuery(month));
    const shown = overview.data?.month ?? month ?? currentMonth();
    const now = currentMonth();
    const next = shiftMonth(shown, 1);

    return (
        <div className="page">
            <div className="page-head">
                <div>
                    <h1>Overview</h1>
                    <p className="sub">What Cue has cost, against what everyone may spend.</p>
                </div>
                <div className="toolbar">
                    <Link to="/" search={{ month: shiftMonth(shown, -1) }} className="btn icon-btn" aria-label="Previous month">
                        <ChevronLeft />
                    </Link>
                    <span className="num" style={{ minWidth: 112, textAlign: 'center', fontWeight: 550 }} aria-live="polite">
                        {monthLabel(shown)}
                    </span>
                    {shown >= now ? (
                        <button type="button" className="btn icon-btn" disabled aria-label="Next month">
                            <ChevronRight />
                        </button>
                    ) : (
                        <Link to="/" search={{ month: next >= now ? undefined : next }} className="btn icon-btn" aria-label="Next month">
                            <ChevronRight />
                        </Link>
                    )}
                </div>
            </div>
            {overview.isPending ? (
                <OverviewSkeleton />
            ) : overview.error && !overview.data ? (
                <div className="card">
                    <ErrorState error={overview.error} retry={() => void overview.refetch()} />
                </div>
            ) : overview.data ? (
                <OverviewBody overview={overview.data} fading={overview.isPlaceholderData} />
            ) : null}
        </div>
    );
}

function OverviewBody({ overview, fading }: { overview: Overview; fading: boolean }) {
    const share = overview.limitUsd > 0 ? Math.round((overview.usd / overview.limitUsd) * 100) : 0;
    const people = overview.users.active;
    return (
        <>
            <section className={['card', fading && 'fading'].filter(Boolean).join(' ')} aria-label="Spend">
                <div className="stat-row">
                    <div>
                        <div className="stat-value num">{usd(overview.usd)}</div>
                        <div className="muted">spent in {monthLabel(overview.month)}</div>
                    </div>
                    <div className="stat-meter">
                        <div className="stat-line num" style={{ marginTop: 0 }}>
                            <span>{share}% of the limits</span>
                            <span>
                                {usd(overview.limitUsd)} across {people} {people === 1 ? 'person' : 'people'}
                            </span>
                        </div>
                        <Meter value={overview.usd} max={overview.limitUsd} />
                    </div>
                </div>
            </section>
            <section className={['card', fading && 'fading'].filter(Boolean).join(' ')} aria-label="Spend per day">
                <div className="card-head">
                    <h2>Per day</h2>
                </div>
                <DayChart days={overview.byDay} title={`Spend per day in ${monthLabel(overview.month)}`} />
            </section>
            <div className={['grid-2', fading && 'fading'].filter(Boolean).join(' ')}>
                <section className="card" aria-label="Top users">
                    <div className="card-head">
                        <h2>Top users</h2>
                        <Link to="/users" search={{ sort: 'spend' }} className="muted">
                            All users
                        </Link>
                    </div>
                    {overview.byUser.length === 0 ? (
                        <EmptyState title="Nobody has spent anything">Usage shows up here as people use Cue.</EmptyState>
                    ) : (
                        <ul className="rows">
                            {overview.byUser.map((user) => (
                                <li key={user.id} className="row">
                                    <span className="row-title">
                                        <Link to="/users/$userId" params={{ userId: user.id }}>
                                            {user.name || user.email}
                                        </Link>
                                    </span>
                                    <span className="num">
                                        {usd(user.usd)} <span className="muted">of {usd(user.limitUsd)}</span>
                                    </span>
                                    <Meter value={user.usd} max={user.limitUsd} />
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
                <section className="card" aria-label="By feature">
                    <div className="card-head">
                        <h2>By feature</h2>
                    </div>
                    {overview.byFeature.length === 0 ? (
                        <EmptyState title="No usage yet">Each feature’s spend appears here.</EmptyState>
                    ) : (
                        <ul className="rows">
                            {overview.byFeature.map((feature) => (
                                <li key={feature.feature} className="row">
                                    <span className="row-title">{featureName(feature.feature)}</span>
                                    <span className="num">
                                        {usd(feature.usd)}{' '}
                                        <span className="muted">
                                            {overview.usd > 0 ? Math.round((feature.usd / overview.usd) * 100) : 0}%
                                        </span>
                                    </span>
                                    <Meter value={feature.usd} max={overview.usd} />
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>
        </>
    );
}

function OverviewSkeleton() {
    return (
        <div aria-busy="true" className="page" style={{ gap: 20 }}>
            <div className="card" style={{ height: 120, display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Skeleton width={140} height={32} />
                <Skeleton width="60%" />
            </div>
            <div className="card" style={{ height: 292 }}>
                <Skeleton width={96} />
            </div>
            <div className="grid-2">
                <div className="card" style={{ height: 240 }} />
                <div className="card" style={{ height: 240 }} />
            </div>
        </div>
    );
}
