// Who may use Cue, as SQL: one place for the statements that invite, enable, disable and revoke, run by the admin API (through
// `env.DB.batch`) and by the owner's script (`scripts/invite.ts`, through `cf d1 raw`), so the two cannot drift. Plain TypeScript:
// nothing here may import `cloudflare:workers` (Node runs the script).

export type Param = string | number | null;
export interface Statement {
    sql: string;
    params: Param[];
}

/** The KV key that stops a disabled person's access tokens working before they expire. */
export const denylistKey = (userId: string) => `disabled:${userId}`;

export const EMAIL_PATTERN = /^[^\s@'";]+@[^\s@'";]+\.[^\s@'";]+$/;

/** An email as the invite table keeps it, or null when it isn't one. */
export function normalizeEmail(text: string): string | null {
    const email = text.trim().toLowerCase();
    return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null;
}

/** Adds an invite; one that is already there is left as it is. */
export const addInvite = (email: string): Statement[] => [
    { sql: 'INSERT INTO invite (email, disabled) VALUES (?, 0) ON CONFLICT(email) DO NOTHING', params: [email] },
];

/** Lets `email` in (again): the invite is on and the account, if there is one, is no longer banned. */
export const enableAccount = (email: string): Statement[] => [
    { sql: 'INSERT INTO invite (email, disabled) VALUES (?, 0) ON CONFLICT(email) DO UPDATE SET disabled = 0', params: [email] },
    { sql: 'UPDATE user SET banned = 0, banReason = NULL, banExpires = NULL WHERE email = ?', params: [email] },
];

/**
 * Turns `email` away: the invite is off, the account banned and every session and token revoked. Their access tokens (valid for up to
 * 15 minutes) stop working at once only with the denylist entry too (`denylistKey`), which the caller sets once it knows the user's id.
 */
export const disableAccount = (email: string): Statement[] => [
    { sql: 'INSERT INTO invite (email, disabled) VALUES (?, 1) ON CONFLICT(email) DO UPDATE SET disabled = 1', params: [email] },
    { sql: "UPDATE user SET banned = 1, banReason = 'disabled by the owner' WHERE email = ?", params: [email] },
    { sql: 'DELETE FROM oauthRefreshToken WHERE userId IN (SELECT id FROM user WHERE email = ?)', params: [email] },
    { sql: 'DELETE FROM oauthAccessToken WHERE userId IN (SELECT id FROM user WHERE email = ?)', params: [email] },
    { sql: 'DELETE FROM session WHERE userId IN (SELECT id FROM user WHERE email = ?)', params: [email] },
];

/** Withdraws an invite nobody has signed in with (an account that exists is disabled, not revoked). */
export const revokeInvite = (email: string): Statement[] => [
    {
        sql: 'DELETE FROM invite WHERE email = ? AND disabled = 0 AND NOT EXISTS (SELECT 1 FROM user WHERE lower(user.email) = invite.email)',
        params: [email],
    },
];

/** Every invite with who signed in with it, oldest first. */
export const LIST_INVITES: Statement = {
    sql: `SELECT i.email AS email, i.disabled AS disabled, i.created_at AS created_at, u.id AS user_id
FROM invite i LEFT JOIN user u ON lower(u.email) = i.email ORDER BY i.created_at, i.email`,
    params: [],
};

export type InviteState = 'pending' | 'accepted' | 'disabled';

export function inviteState(row: { disabled: unknown; user_id: unknown }): InviteState {
    return row.disabled ? 'disabled' : row.user_id ? 'accepted' : 'pending';
}
