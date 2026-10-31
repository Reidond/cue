import type { AdminSession } from '@cue/contract';
import { type QueryClient, useQuery } from '@tanstack/react-query';
import { createRootRouteWithContext, Link, Outlet } from '@tanstack/react-router';
import { InviteIcon, OverviewIcon, SettingsIcon, SignOutIcon, UsersIcon } from '../components/icons.tsx';
import { Button, ErrorState } from '../components/ui.tsx';
import { ApiFailure } from '../lib/api.ts';
import { sessionQuery, settingsQuery } from '../lib/queries.ts';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    component: Root,
    notFoundComponent: () => (
        <div className="page">
            <div className="card">
                <div className="state">
                    <h2>There’s nothing here</h2>
                    <p>This page doesn’t exist.</p>
                    <Link to="/" className="btn">
                        Back to the overview
                    </Link>
                </div>
            </div>
        </div>
    ),
});

function Root() {
    const session = useQuery(sessionQuery());
    if (session.isPending) return <div className="centered" aria-busy="true" />;
    if (session.error instanceof ApiFailure && session.error.status === 401) return <SignIn />;
    if (session.error) {
        return (
            <div className="centered">
                <div className="card">
                    <ErrorState error={session.error} retry={() => void session.refetch()} />
                </div>
            </div>
        );
    }
    if (session.data.role !== 'admin') return <NotAllowed who={session.data} />;
    return <Shell who={session.data} />;
}

// The same sign-in pages as the Mac app (Google or GitHub); `next=admin` brings the browser back here once the session exists.
function SignIn() {
    return (
        <main className="centered">
            <div className="panel">
                <div>
                    <h1>Cue admin</h1>
                    <p>Sign in with the Google or GitHub account that owns Cue.</p>
                </div>
                <div className="stack">
                    <a className="btn btn-primary btn-wide" href="/login/google?next=admin">
                        Continue with Google
                    </a>
                    <a className="btn btn-wide" href="/login/github?next=admin">
                        Continue with GitHub
                    </a>
                </div>
            </div>
        </main>
    );
}

async function signOut() {
    await fetch('/api/auth/sign-out', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(
        () => undefined,
    );
    location.assign('/admin/');
}

function NotAllowed({ who }: { who: AdminSession }) {
    return (
        <main className="centered">
            <div className="panel">
                <div>
                    <h1>Not allowed</h1>
                    <p>
                        {who.email} can use Cue, but isn’t one of its owners, so the admin is closed to them. Sign in with the owner’s
                        account instead.
                    </p>
                </div>
                <Button onClick={() => void signOut()}>Sign out</Button>
            </div>
        </main>
    );
}

function Shell({ who }: { who: AdminSession }) {
    const settings = useQuery(settingsQuery());
    return (
        <div className="shell">
            <aside className="sidebar">
                <div className="brand">
                    Cue <span>Admin</span>
                </div>
                <nav className="nav" aria-label="Admin">
                    <Link to="/" activeOptions={{ exact: true }}>
                        <OverviewIcon />
                        Overview
                    </Link>
                    <Link to="/users">
                        <UsersIcon />
                        Users
                    </Link>
                    <Link to="/invites">
                        <InviteIcon />
                        Invites
                    </Link>
                    <Link to="/settings">
                        <SettingsIcon />
                        Settings
                    </Link>
                </nav>
                <div className="account">
                    <div className="account-who">
                        <strong>{who.name}</strong>
                        <span>{who.email}</span>
                    </div>
                    <Button size="small" tone="quiet" onClick={() => void signOut()}>
                        <SignOutIcon />
                        Sign out
                    </Button>
                </div>
            </aside>
            <main className="main">
                {settings.data?.planPaused ? (
                    <output className="banner banner-warn" style={{ marginBottom: 20, maxWidth: 1040 }}>
                        <span>The plan is paused: everyone using Cue is told to try again later.</span>
                        <Link to="/settings" className="btn btn-small">
                            Settings
                        </Link>
                    </output>
                ) : null}
                <Outlet />
            </main>
        </div>
    );
}
