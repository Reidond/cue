import type { AdminUser, AdminUserDetail } from '@cue/contract';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { DayChart } from '../components/DayChart.tsx';
import { ChevronLeft } from '../components/icons.tsx';
import { Badge, Button, Confirm, EmptyState, ErrorState, messageOf, Meter, MoneyField, Skeleton } from '../components/ui.tsx';
import { ApiFailure } from '../lib/api.ts';
import { ago, featureName, fullDate, fullTime, monthLabel, usd } from '../lib/format.ts';
import { sessionQuery, settingsQuery, useSetUserDisabled, useSetUserLimit, userQuery } from '../lib/queries.ts';

export const Route = createFileRoute('/users/$userId')({
    loader: ({ context, params }) => {
        void context.queryClient.prefetchQuery(userQuery(params.userId, undefined));
    },
    component: UserPage,
});

function UserPage() {
    const { userId } = Route.useParams();
    const detail = useQuery(userQuery(userId, undefined));

    return (
        <div className="page">
            <Link to="/users" className="back">
                <ChevronLeft />
                Users
            </Link>
            {detail.isPending ? (
                <UserSkeleton />
            ) : detail.error ? (
                <div className="card">
                    {detail.error instanceof ApiFailure && detail.error.status === 404 ? (
                        <EmptyState
                            title="No such user"
                            action={
                                <Link to="/users" className="btn">
                                    Back to users
                                </Link>
                            }
                        >
                            They may have been removed, or the link is wrong.
                        </EmptyState>
                    ) : (
                        <ErrorState error={detail.error} retry={() => void detail.refetch()} />
                    )}
                </div>
            ) : (
                <UserBody detail={detail.data} />
            )}
        </div>
    );
}

function UserBody({ detail }: { detail: AdminUserDetail }) {
    const { user } = detail;
    const self = useQuery(sessionQuery()).data;
    const disabled = user.status === 'disabled';
    const toggle = useSetUserDisabled(user.id);
    const isSelf = self?.id === user.id;

    return (
        <>
            <div className="page-head">
                <div>
                    <h1>{user.name || user.email}</h1>
                    <p className="sub">{user.email}</p>
                </div>
                <div className="toolbar">
                    {disabled ? (
                        <Badge tone="bad">Disabled</Badge>
                    ) : user.role === 'admin' ? (
                        <Badge>Owner</Badge>
                    ) : (
                        <Badge tone="good">Active</Badge>
                    )}
                    {isSelf ? (
                        <Button disabled title="You can’t disable your own account">
                            Disable
                        </Button>
                    ) : disabled ? (
                        <Confirm
                            title={`Let ${user.email} back in?`}
                            description="They can sign in to Cue again, and their usage carries on from where it was."
                            confirm="Enable"
                            tone="primary"
                            onConfirm={() => toggle.mutate(false)}
                        >
                            <Button tone="primary">Enable</Button>
                        </Confirm>
                    ) : (
                        <Confirm
                            title={`Disable ${user.email}?`}
                            description="They are signed out of Cue everywhere at once and can’t sign in again until you enable them. Their usage history stays."
                            confirm="Disable"
                            onConfirm={() => toggle.mutate(true)}
                        >
                            <Button tone="danger">Disable</Button>
                        </Confirm>
                    )}
                </div>
            </div>

            {toggle.error ? (
                <div className="banner" role="alert">
                    {messageOf(toggle.error)}
                </div>
            ) : null}

            <section className="card" aria-label="Spend">
                <div className="stat-row">
                    <div>
                        <div className="stat-value num">{usd(user.usd)}</div>
                        <div className="muted">spent in {monthLabel(detail.month)}</div>
                    </div>
                    <div className="stat-meter">
                        <div className="stat-line num" style={{ marginTop: 0 }}>
                            <span>{user.limitUsd > 0 ? Math.round((user.usd / user.limitUsd) * 100) : 0}% of their limit</span>
                            <span>
                                {usd(user.limitUsd)} {user.customLimit ? 'set for them' : 'default'}
                            </span>
                        </div>
                        <Meter value={user.usd} max={user.limitUsd} />
                    </div>
                </div>
                <dl className="meta">
                    <div>
                        <dt>Last active</dt>
                        <dd className="num">
                            {user.lastActiveAt === null ? (
                                'Never'
                            ) : (
                                <time dateTime={new Date(user.lastActiveAt).toISOString()} title={fullTime(user.lastActiveAt)}>
                                    {ago(user.lastActiveAt)}
                                </time>
                            )}
                        </dd>
                    </div>
                    <div>
                        <dt>Joined</dt>
                        <dd className="num">{user.createdAt ? fullDate(user.createdAt) : '—'}</dd>
                    </div>
                    <div>
                        <dt>Role</dt>
                        <dd>{user.role === 'admin' ? 'Owner' : 'Member'}</dd>
                    </div>
                </dl>
            </section>

            <div className="grid-2">
                <LimitCard key={`${user.id}:${user.limitUsd}:${user.customLimit}`} user={user} />
                <section className="card" aria-label="By feature">
                    <div className="card-head">
                        <h2>By feature</h2>
                    </div>
                    {detail.byFeature.length === 0 ? (
                        <EmptyState title="No usage this month">What they use Cue for appears here.</EmptyState>
                    ) : (
                        <ul className="rows">
                            {detail.byFeature.map((feature) => (
                                <li key={feature.feature} className="row">
                                    <span className="row-title">{featureName(feature.feature)}</span>
                                    <span className="num">{usd(feature.usd)}</span>
                                    <Meter value={feature.usd} max={user.usd} />
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>

            <section className="card" aria-label="Spend per day">
                <div className="card-head">
                    <h2>Per day</h2>
                </div>
                <DayChart days={detail.byDay} title={`${user.name || user.email}’s spend per day in ${monthLabel(detail.month)}`} />
            </section>
        </>
    );
}

// Remounted when the saved limit changes (the key), so the draft always starts from what is saved.
function LimitCard({ user }: { user: AdminUser }) {
    const [draft, setDraft] = useState<number | null>(user.limitUsd);
    const defaults = useQuery(settingsQuery()).data?.defaultMonthlyLimitUsd;
    const save = useSetUserLimit(user.id);
    const dirty = draft !== user.limitUsd;

    return (
        <section className="card" aria-label="Monthly limit">
            <div className="card-head">
                <h2>Monthly limit</h2>
                <Badge plain>{user.customLimit ? 'Set for them' : 'Default'}</Badge>
            </div>
            <form
                className="limit-form"
                onSubmit={(event) => {
                    event.preventDefault();
                    if (draft !== null && dirty) save.mutate(draft);
                }}
            >
                <MoneyField label="Monthly limit in dollars" value={draft} onChange={setDraft} step={5} />
                <Button type="submit" tone="primary" disabled={!dirty || draft === null || save.isPending}>
                    Save
                </Button>
                {user.customLimit ? (
                    <Button tone="quiet" onClick={() => save.mutate(null)} disabled={save.isPending}>
                        Use the default{defaults === undefined ? '' : ` (${usd(defaults)})`}
                    </Button>
                ) : null}
            </form>
            <p className="field-hint" style={{ marginTop: 10 }}>
                What the app lets them spend each month. It applies from now on, to this month’s spend too.
            </p>
            <div className="field-error" role="alert" style={{ marginTop: 6 }}>
                {save.error ? messageOf(save.error) : null}
            </div>
        </section>
    );
}

function UserSkeleton() {
    return (
        <div aria-busy="true" className="page" style={{ gap: 20 }}>
            <div className="page-head">
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <Skeleton width={220} height={24} />
                    <Skeleton width={160} />
                </div>
            </div>
            <div className="card" style={{ height: 176 }} />
            <div className="grid-2">
                <div className="card" style={{ height: 180 }} />
                <div className="card" style={{ height: 180 }} />
            </div>
        </div>
    );
}
