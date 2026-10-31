import type { AdminInvite } from '@cue/contract';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Badge, Button, EmptyState, ErrorState, messageOf, Skeleton } from '../components/ui.tsx';
import { fullDate } from '../lib/format.ts';
import { invitesQuery, useAddInvite, useRevokeInvite } from '../lib/queries.ts';

export const Route = createFileRoute('/invites')({
    loader: ({ context }) => {
        void context.queryClient.prefetchQuery(invitesQuery());
    },
    component: InvitesPage,
});

function InvitesPage() {
    const invites = useQuery(invitesQuery());
    const pending = invites.data?.invites.filter((invite) => invite.status === 'pending') ?? [];
    const accepted = invites.data?.invites.filter((invite) => invite.status !== 'pending') ?? [];

    return (
        <div className="page">
            <div className="page-head">
                <div>
                    <h1>Invites</h1>
                    <p className="sub">Cue is invite-only. Someone signs in with the Google or GitHub email you invite.</p>
                </div>
            </div>
            <section className="card" aria-label="Invite someone">
                <InviteForm />
            </section>

            {invites.isPending ? (
                <div className="card table-card" aria-busy="true">
                    <div className="state" style={{ minHeight: 120 }}>
                        <Skeleton width={180} />
                        <Skeleton width={120} />
                    </div>
                </div>
            ) : invites.error && !invites.data ? (
                <div className="card">
                    <ErrorState error={invites.error} retry={() => void invites.refetch()} />
                </div>
            ) : (
                <>
                    <InviteList
                        title="Waiting to sign in"
                        invites={pending}
                        empty="No one is waiting."
                        emptyHint="Invites that haven’t been used yet appear here."
                        revocable
                    />
                    <InviteList
                        title="Signed in"
                        invites={accepted}
                        empty="No one has signed in yet."
                        emptyHint="Once an invited person signs in, they move here and appear under Users."
                    />
                </>
            )}
        </div>
    );
}

function InviteForm() {
    const [email, setEmail] = useState('');
    const add = useAddInvite();
    const [added, setAdded] = useState<string | null>(null);

    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                const address = email.trim();
                if (!address) return;
                add.mutate(address, {
                    onSuccess: (invite) => {
                        setEmail('');
                        setAdded(invite.email);
                    },
                });
            }}
        >
            <div className="form-row">
                <div className="field">
                    <label className="field-label" htmlFor="invite-email">
                        Email address
                    </label>
                    <input
                        id="invite-email"
                        className="input"
                        type="email"
                        autoComplete="off"
                        placeholder="name@example.com"
                        value={email}
                        onChange={(event) => {
                            setEmail(event.target.value);
                            setAdded(null);
                            if (add.error) add.reset();
                        }}
                        aria-invalid={add.error ? true : undefined}
                        aria-describedby="invite-feedback"
                    />
                    <div
                        id="invite-feedback"
                        className={add.error ? 'field-error' : 'field-hint'}
                        role={add.error ? 'alert' : 'status'}
                        style={{ minHeight: 20 }}
                    >
                        {add.error ? messageOf(add.error) : added ? `${added} is invited.` : 'The email of their Google or GitHub account.'}
                    </div>
                </div>
                <Button type="submit" tone="primary" disabled={add.isPending || email.trim() === ''} style={{ marginTop: 26 }}>
                    Invite
                </Button>
            </div>
        </form>
    );
}

function InviteList({
    title,
    invites,
    empty,
    emptyHint,
    revocable,
}: {
    title: string;
    invites: AdminInvite[];
    empty: string;
    emptyHint: string;
    revocable?: boolean;
}) {
    const revoke = useRevokeInvite();
    return (
        <section className="card table-card" aria-label={title}>
            <div className="card-head" style={{ padding: '16px 16px 0' }}>
                <h2>
                    {title} <span className="muted num">{invites.length}</span>
                </h2>
            </div>
            {invites.length === 0 ? (
                <EmptyState title={empty}>{emptyHint}</EmptyState>
            ) : (
                <div className="table-wrap">
                    <table className="table">
                        <thead>
                            <tr>
                                <th scope="col">Email</th>
                                <th scope="col">Status</th>
                                <th scope="col">Invited</th>
                                <th scope="col" className="right">
                                    <span className="sr-only">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {invites.map((invite) => (
                                <tr key={invite.email}>
                                    <td>
                                        <div className="cell-user">
                                            <strong>{invite.email}</strong>
                                        </div>
                                    </td>
                                    <td>
                                        {invite.status === 'pending' ? (
                                            <Badge tone="warn">Pending</Badge>
                                        ) : invite.status === 'disabled' ? (
                                            <Badge tone="bad">Disabled</Badge>
                                        ) : (
                                            <Badge tone="good">Accepted</Badge>
                                        )}
                                    </td>
                                    <td className="num">{fullDate(invite.createdAt)}</td>
                                    <td className="right">
                                        {revocable ? (
                                            <Button
                                                size="small"
                                                tone="danger"
                                                onClick={() => revoke.mutate(invite.email)}
                                                aria-label={`Revoke the invite for ${invite.email}`}
                                            >
                                                Revoke
                                            </Button>
                                        ) : invite.userId ? (
                                            <Link to="/users/$userId" params={{ userId: invite.userId }} className="btn btn-small">
                                                View
                                            </Link>
                                        ) : null}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
            {revoke.error ? (
                <div className="banner" role="alert" style={{ margin: 12 }}>
                    {messageOf(revoke.error)}
                </div>
            ) : null}
        </section>
    );
}
