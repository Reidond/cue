import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRouter, RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ApiFailure } from './lib/api.ts';
import { routeTree } from './routeTree.gen.ts';
import './styles/app.css';

const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            staleTime: 15_000,
            // A refusal (signed out, not an admin, no such user) is an answer; only a network or server failure is worth asking again.
            retry: (count, error) => !(error instanceof ApiFailure && error.status >= 400 && error.status < 500) && count < 2,
        },
    },
});

const router = createRouter({
    routeTree,
    basepath: '/admin',
    context: { queryClient },
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
});

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router;
    }
}

createRoot(document.getElementById('root')!).render(
    <StrictMode>
        <QueryClientProvider client={queryClient}>
            <RouterProvider router={router} />
        </QueryClientProvider>
    </StrictMode>,
);
