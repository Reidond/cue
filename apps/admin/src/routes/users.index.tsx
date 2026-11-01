import { ToggleGroup } from '@base-ui/react/toggle-group';
import { Toggle } from '@base-ui/react/toggle';
import type { AdminUser } from '@cue/contract';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, SearchIcon } from '../components/icons.tsx';
import { Badge, EmptyState, ErrorState, Meter, Skeleton } from '../components/ui.tsx';
import { ago, fullTime, usd } from '../lib/format.ts';
import { type UserFilters, usersQuery } from '../lib/queries.ts';

const STATUSES = ['all', 'active', 'disabled'] as const;
const SORTS = ['recent', 'spend', 'name'] as const;
const SORT_LABELS = { recent: 'Last active', spend: 'Spend', name: 'Email' } as const;

interface UsersSearch {
    q?: string;
    status?: 'active' | 'disabled';
    sort?: 'spend' | 'name';
    page?: number;
}

export const Route = createFileRoute('/users/')({
    // Defaults stay out of the URL: /users is "everyone, by last activity, first page".
    validateSearch: (search: Record<string, unknown>): UsersSearch => {
        const q = typeof search['q'] === 'string' ? search['q'].trim().slice(0, 200) : '';
        const page = Number(search['page']);
        return {
            q: q || undefined,
            status: search['status'] === 'active' || search['status'] === 'disabled' ? search['status'] : undefined,
            sort: search['sort'] === 'spend' || search['sort'] === 'name' ? search['sort'] : undefined,
            page: Number.isInteger(page) && page > 1 ? page : undefined,
        };
    },
    loaderDeps: ({ search }) => search,
    loader: ({ context, deps }) => {
        void context.queryClient.prefetchQuery(usersQuery(filtersOf(deps)));
    },
    component: UsersPage,
});

const filtersOf = (search: UsersSearch): UserFilters => ({
    q: search.q ?? '',
    status: search.status ?? 'all',
    sort: search.sort ?? 'recent',
    page: search.page ?? 1,
});

function UsersPage() {
    const search = Route.useSearch();
    const navigate = useNavigate({ from: Route.fullPath });
    const filters = filtersOf(search);
    const users = useQuery(usersQuery(filters));
    const [text, setText] = useState(search.q ?? '');
    const timer = useRef<number | undefined>(undefined);

    // A search still waiting to reach the URL must not follow the person to another page.
    useEffect(() => () => window.clearTimeout(timer.current), []);

    // Typing moves the URL a moment after the last key, so each letter isn't a request.
    function onSearch(value: string) {
        setText(value);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
            void navigate({ search: (previous) => ({ ...previous, q: value.trim() || undefined, page: undefined }), replace: true });
        }, 250);
    }

    const filtered = filters.q !== '' || filters.status !== 'all';
    const data = users.data;

    return (
        <div className="page">
            <div className="page-head">
                <div>
                    <h1>Users</h1>
                    <p className="sub">Everyone who has signed in to Cue.</p>
                </div>
            </div>
            <div className="toolbar">
                <div className="search">
                    <SearchIcon />
                    <input
                        className="input"
                        type="search"
                        value={text}
                        onChange={(event) => onSearch(event.target.value)}
                        placeholder="Search name or email"
                        aria-label="Search users"
                    />
                </div>
                <ToggleGroup
                    className="seg"
                    aria-label="Status"
                    value={[filters.status]}
                    onValueChange={(next) => {
                        const status = next[0];
                        // Pressing the pressed item would clear the group; a segmented control always has one selected.
                        if (status === 'all' || status === 'active' || status === 'disabled') {
                            void navigate({
                                search: (previous) => ({ ...previous, status: status === 'all' ? undefined : status, page: undefined }),
                            });
                        }
                    }}
                >
                    {STATUSES.map((status) => (
                        <Toggle key={status} value={status} className="seg-item">
                            {status === 'all' ? 'All' : status === 'active' ? 'Active' : 'Disabled'}
                        </Toggle>
                    ))}
                </ToggleGroup>
                <span className="grow" />
                <label className="toolbar">
                    <span className="muted">Sort by</span>
                    <select
                        className="input"
                        style={{ width: 'auto', minWidth: 130 }}
                        value={filters.sort}
                        onChange={(event) => {
                            const sort = event.target.value;
                            void navigate({
                                search: (previous) => ({
                                    ...previous,
                                    sort: sort === 'spend' || sort === 'name' ? sort : undefined,
                                    page: undefined,
                                }),
                            });
                        }}
                    >
                        {SORTS.map((sort) => (
                            <option key={sort} value={sort}>
                                {SORT_LABELS[sort]}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            <div className="card table-card">
                {users.isPending ? (
                    <UsersSkeleton />
                ) : users.error && !data ? (
                    <ErrorState error={users.error} retry={() => void users.refetch()} />
                ) : data && data.users.length === 0 ? (
                    filtered ? (
                        <EmptyState
                            title="Nobody matches"
                            action={
                                <Link
                                    to="/users"
                                    className="btn"
                                    onClick={() => {
                                        window.clearTimeout(timer.current);
                                        setText('');
                                    }}
                                >
                                    Clear the filters
                                </Link>
                            }
                        >
                            Try another name, or look at everyone.
                        </EmptyState>
                    ) : (
                        <EmptyState
                            title="Nobody has signed in yet"
                            action={
                                <Link to="/invites" className="btn">
                                    Invite someone
                                </Link>
                            }
                        >
                            People appear here after they sign in with an invited email.
                        </EmptyState>
                    )
                ) : data ? (
                    <div className={['table-wrap', users.isPlaceholderData && 'fading'].filter(Boolean).join(' ')}>
                        <table className="table">
                            <thead>
                                <tr>
                                    <th scope="col">User</th>
                                    <th scope="col">Status</th>
                                    <th scope="col">Spend this month</th>
                                    <th scope="col">Last active</th>
                                    <th scope="col">
                                        <span className="sr-only">Open</span>
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.users.map((user) => (
                                    <UserRow key={user.id} user={user} />
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : null}
            </div>

            {data && data.total > 0 ? (
                <nav className="pager" aria-label="Pages">
                    <span className="num">
                        {(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} of {data.total}
                    </span>
                    <div className="pager-buttons">
                        {data.page > 1 ? (
                            <Link
                                to="/users"
                                search={(previous) => ({ ...previous, page: data.page - 1 > 1 ? data.page - 1 : undefined })}
                                className="btn btn-small"
                            >
                                <ChevronLeft />
                                Previous
                            </Link>
                        ) : (
                            <button type="button" className="btn btn-small" disabled>
                                <ChevronLeft />
                                Previous
                            </button>
                        )}
                        {data.page * data.pageSize < data.total ? (
                            <Link to="/users" search={(previous) => ({ ...previous, page: data.page + 1 })} className="btn btn-small">
                                Next
                                <ChevronRight />
                            </Link>
                        ) : (
                            <button type="button" className="btn btn-small" disabled>
                                Next
                                <ChevronRight />
                            </button>
                        )}
                    </div>
                </nav>
            ) : null}
        </div>
    );
}

function UserRow({ user }: { user: AdminUser }) {
    return (
        <tr className="row-link">
            <td>
                <div className="cell-user">
                    <Link to="/users/$userId" params={{ userId: user.id }}>
                        {user.name || user.email}
                    </Link>
                    <span>{user.email}</span>
                </div>
            </td>
            <td>
                {user.status === 'disabled' ? (
                    <Badge tone="bad">Disabled</Badge>
                ) : user.role === 'admin' ? (
                    <Badge>Owner</Badge>
                ) : (
                    <Badge tone="good">Active</Badge>
                )}
            </td>
            <td>
                <div className="cell-spend num">
                    <div className="line">
                        <span>{usd(user.usd)}</span>
                        <span className="muted">of {usd(user.limitUsd)}</span>
                    </div>
                    <Meter value={user.usd} max={user.limitUsd} />
                </div>
            </td>
            <td className="num">
                {user.lastActiveAt === null ? (
                    <span className="muted">Never</span>
                ) : (
                    <time dateTime={new Date(user.lastActiveAt).toISOString()} title={fullTime(user.lastActiveAt)}>
                        {ago(user.lastActiveAt)}
                    </time>
                )}
            </td>
            <td className="right">
                <ChevronRight className="chevron" />
            </td>
        </tr>
    );
}

function UsersSkeleton() {
    return (
        <div className="table-wrap" aria-busy="true">
            <table className="table">
                <tbody>
                    {Array.from({ length: 5 }, (_, index) => (
                        <tr key={index}>
                            <td>
                                <Skeleton width={160} />
                            </td>
                            <td>
                                <Skeleton width={56} />
                            </td>
                            <td>
                                <Skeleton width={120} />
                            </td>
                            <td>
                                <Skeleton width={72} />
                            </td>
                            <td />
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
