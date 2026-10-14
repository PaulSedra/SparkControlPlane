/**
 * @fileoverview Browser-history route state and navigation helpers for the
 * React application shell.
 */

import { useEffect, useState } from 'react';
import type { AppRoute, CurrentRoute, RouteMatch } from './routeTypes.ts';
import { APP_ROUTES } from './routes';

/**
 * Subscribes to browser history and app navigation events and resolves the
 * current route.
 *
 * Both native back/forward and `navigateTo` updates use the same location
 * snapshot, so route pages observe one source of truth. The hook removes both
 * listeners on unmount and returns decoded path parameters from the first
 * matching route definition.
 */
export function useCurrentRoute(): CurrentRoute {
    const [location, setLocation] = useState(readLocation);

    useEffect(() => {
        function handleLocationChange() {
            setLocation(readLocation());
        }

        window.addEventListener('popstate', handleLocationChange);
        window.addEventListener('spark-control-plane:navigate', handleLocationChange);

        return () => {
            window.removeEventListener('popstate', handleLocationChange);
            window.removeEventListener('spark-control-plane:navigate', handleLocationChange);
        };
    }, []);

    return {
        match: matchRoute(location.pathname, APP_ROUTES),
        pathname: location.pathname,
        search: location.search,
    };
}

/**
 * Pushes an in-app path without a document reload and notifies route
 * subscribers through the app's navigation event.
 *
 * Repeating the current path is a no-op, which prevents unnecessary history
 * entries and controller reloads. This helper is browser-only and deliberately
 * leaves server-side routing/fallback behavior to the host.
 */
export function navigateTo(path: string) {
    const currentPath = `${window.location.pathname}${window.location.search}`;
    if (currentPath === path) {
        return;
    }

    window.history.pushState({}, '', path);
    window.dispatchEvent(new Event('spark-control-plane:navigate'));
}

/**
 * Builds a URL-safe pipeline/run deep link used by list and detail views.
 * Both identifiers are encoded as path segments so names containing spaces or
 * reserved characters cannot change route structure.
 */
export function pipelineRunPath(pipelineId: string, runId: string): string {
    return `/pipelines/${encodeURIComponent(pipelineId)}/runs/${encodeURIComponent(runId)}`;
}

function readLocation(): { pathname: string; search: string } {
    return {
        pathname: window.location.pathname,
        search: window.location.search,
    };
}

function matchRoute(
    pathname: string,
    routes: readonly AppRoute[],
): RouteMatch | undefined {
    const normalizedPath = normalizePath(pathname);
    for (const route of routes) {
        const params = matchPath(route.path, normalizedPath);
        if (params != null) {
            return { params, route };
        }
    }

    return undefined;
}

function normalizePath(pathname: string): string {
    if (pathname === '') {
        return '/';
    }

    if (pathname.length <= 1) {
        return pathname;
    }

    let normalized = pathname;
    while (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
    }
    return normalized;
}

function matchPath(pattern: string, pathname: string): Record<string, string> | undefined {
    const patternParts = pattern.split('/').filter(Boolean);
    const pathParts = pathname.split('/').filter(Boolean);

    if (patternParts.length !== pathParts.length) {
        return undefined;
    }

    const params: Record<string, string> = {};
    for (let index = 0; index < patternParts.length; index += 1) {
        const patternPart = patternParts[index];
        const pathPart = pathParts[index];

        if (patternPart.startsWith(':')) {
            params[patternPart.slice(1)] = decodeURIComponent(pathPart);
        } else if (patternPart !== pathPart) {
            return undefined;
        }
    }

    return params;
}
