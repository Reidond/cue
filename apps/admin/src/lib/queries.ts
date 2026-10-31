import type { AdminInvite, AdminInvites, AdminSettings, AdminUser, AdminUserDetail, AdminUsers } from '@cue/contract';
import { keepPreviousData, queryOptions, type QueryClient, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, unwrap } from './api.ts';

// One key family per resource. A mutation names the family it changes and invalidates that prefix.
export const keys = {
    session: ['session'] as const,
    overview: (month: string | undefined) => ['overview', month ?? 'current'] as const,
    users: {
        all: ['users'] as const,
        list: (filters: UserFilters) => ['users', 'list', filters] as const,
        detail: (id: string, month: string | undefined) => ['users', 'detail', id, month ?? 'current'] as const,
    },
    invites: ['invites'] as const,
    settings: ['settings'] as const,
};

export interface UserFilters {
    q: string;
    status: 'all' | 'active' | 'disabled';
    sort: 'recent' | 'spend' | 'name';
    page: number;
}

export const sessionQuery = () =>
    queryOptions({ queryKey: keys.session, queryFn: () => unwrap(api.session.get()), staleTime: 60_000, retry: false });

export const overviewQuery = (month: string | undefined) =>
    queryOptions({
        queryKey: keys.overview(month),
        queryFn: () => unwrap(api.overview.get({ query: { month } })),
        placeholderData: keepPreviousData,
    });

export const usersQuery = (filters: UserFilters) =>
    queryOptions({
        queryKey: keys.users.list(filters),
        queryFn: () =>
            unwrap(
                api.users.get({
                    query: {
                        q: filters.q || undefined,
                        status: filters.status === 'all' ? undefined : filters.status,
                        sort: filters.sort === 'recent' ? undefined : filters.sort,
                        page: filters.page === 1 ? undefined : filters.page,
                    },
                }),
            ),
        placeholderData: keepPreviousData,
    });

export const userQuery = (id: string, month: string | undefined) =>
    queryOptions({ queryKey: keys.users.detail(id, month), queryFn: () => unwrap(api.users({ id }).get({ query: { month } })) });

export const invitesQuery = () => queryOptions({ queryKey: keys.invites, queryFn: () => unwrap(api.invites.get()) });

export const settingsQuery = () => queryOptions({ queryKey: keys.settings, queryFn: () => unwrap(api.settings.get()) });

// MARK: Optimistic updates

type Snapshot = [readonly unknown[], unknown][];

/** Applies `change` to the user `id` wherever the cache holds them (a page of the list, their own page), and returns what to put back. */
async function patchUser(queryClient: QueryClient, id: string, change: (user: AdminUser) => AdminUser): Promise<Snapshot> {
    await queryClient.cancelQueries({ queryKey: keys.users.all });
    const snapshot = queryClient.getQueriesData({ queryKey: keys.users.all }) as Snapshot;
    queryClient.setQueriesData<AdminUsers | AdminUserDetail>({ queryKey: keys.users.all }, (old) => {
        if (!old) return old;
        if ('users' in old) return { ...old, users: old.users.map((user) => (user.id === id ? change(user) : user)) };
        return old.user.id === id ? { ...old, user: change(old.user) } : old;
    });
    return snapshot;
}

function restore(queryClient: QueryClient, snapshot: Snapshot | undefined) {
    for (const [key, data] of snapshot ?? []) queryClient.setQueryData(key, data);
}

/** Disabling or enabling a user flips the toggle at once; the server's answer replaces it, and a refusal puts the old state back. */
export function useSetUserDisabled(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (disabled: boolean) => unwrap(disabled ? api.users({ id }).disable.post() : api.users({ id }).enable.post()),
        onMutate: (disabled) => patchUser(queryClient, id, (user) => ({ ...user, status: disabled ? 'disabled' : 'active' })),
        onError: (_error, _disabled, snapshot) => restore(queryClient, snapshot),
        onSettled: () =>
            Promise.all([
                queryClient.invalidateQueries({ queryKey: keys.users.all }),
                queryClient.invalidateQueries({ queryKey: ['overview'] }),
            ]),
    });
}

/** A new monthly limit (null: the default again) shows at once. */
export function useSetUserLimit(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (monthlyUsd: number | null) => unwrap(api.users({ id }).limit.patch({ monthlyUsd })),
        onMutate: async (monthlyUsd) => {
            const defaults = queryClient.getQueryData<AdminSettings>(keys.settings)?.defaultMonthlyLimitUsd;
            return patchUser(queryClient, id, (user) => ({
                ...user,
                customLimit: monthlyUsd !== null,
                limitUsd: monthlyUsd ?? defaults ?? user.limitUsd,
            }));
        },
        onError: (_error, _limit, snapshot) => restore(queryClient, snapshot),
        onSettled: () =>
            Promise.all([
                queryClient.invalidateQueries({ queryKey: keys.users.all }),
                queryClient.invalidateQueries({ queryKey: ['overview'] }),
            ]),
    });
}

export function useAddInvite() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (email: string) => unwrap(api.invites.post({ email })),
        onSuccess: (invite) =>
            queryClient.setQueryData<AdminInvites>(keys.invites, (old) => ({ invites: [...(old?.invites ?? []), invite] })),
        onSettled: () => queryClient.invalidateQueries({ queryKey: keys.invites }),
    });
}

/** The invite leaves the list at once and comes back if the server says no. */
export function useRevokeInvite() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (email: string) => unwrap(api.invites({ email }).delete()),
        onMutate: async (email) => {
            await queryClient.cancelQueries({ queryKey: keys.invites });
            const before = queryClient.getQueryData<AdminInvites>(keys.invites);
            queryClient.setQueryData<AdminInvites>(
                keys.invites,
                (old) => old && { invites: old.invites.filter((invite: AdminInvite) => invite.email !== email) },
            );
            return before;
        },
        onError: (_error, _email, before) => queryClient.setQueryData(keys.invites, before),
        onSettled: () => queryClient.invalidateQueries({ queryKey: keys.invites }),
    });
}

/** Settings are saved as a patch; the toggles in it show their new state before the server answers. */
export function useSaveSettings() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (patch: Partial<AdminSettings>) => unwrap(api.settings.patch(patch)),
        onMutate: async (patch) => {
            await queryClient.cancelQueries({ queryKey: keys.settings });
            const before = queryClient.getQueryData<AdminSettings>(keys.settings);
            queryClient.setQueryData<AdminSettings>(keys.settings, (old) => old && { ...old, ...patch });
            return before;
        },
        onError: (_error, _patch, before) => queryClient.setQueryData(keys.settings, before),
        onSuccess: (saved) => queryClient.setQueryData(keys.settings, saved),
        onSettled: () =>
            Promise.all([
                queryClient.invalidateQueries({ queryKey: keys.settings }),
                queryClient.invalidateQueries({ queryKey: keys.users.all }),
            ]),
    });
}
