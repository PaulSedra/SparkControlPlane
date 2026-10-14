/**
 * @fileoverview Application-wide TanStack Query lifecycle and cache client.
 *
 * The singleton shares server-owned state across routed pages. A factory is
 * also exported so tests can create isolated caches. Defaults favor bounded
 * retries and caching without silently polling or refetching on focus; features
 * opt into those behaviors when their existing contract requires them.
 */

import { QueryClient } from '@tanstack/react-query';

/**
 * Creates an isolated query cache with conservative defaults for application
 * reads. Mutations are never retried automatically because remote commands may
 * not be safe to repeat.
 */
export function createAppQueryClient(): QueryClient {
    return new QueryClient({
        defaultOptions: {
            queries: {
                gcTime: 5 * 60 * 1000,
                refetchOnWindowFocus: false,
                retry: 1,
                staleTime: 30 * 1000,
            },
            mutations: {
                retry: false,
            },
        },
    });
}

/** Shared cache used by the mounted application and all routed features. */
export const queryClient = createAppQueryClient();
