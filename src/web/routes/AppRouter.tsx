/**
 * @fileoverview Resolves the current route and renders the selected page or
 * the not-found fallback.
 */

import { useEffect } from 'react';
import { NotFoundPage } from '../pages/NotFoundPage';
import { useCurrentRoute } from './useCurrentRoute';

/**
 * Resolves the current route, updates the document title, and renders its
 * page component. An unmatched path stays on the explicit not-found page
 * rather than being silently redirected, preserving the browser location for
 * debugging and user recovery.
 */
export default function AppRouter() {
    const { match } = useCurrentRoute();
    const route = match?.route;

    useEffect(() => {
        document.title = route?.title ?? 'Control Plane';
    }, [route?.title]);

    if (route == null) {
        return <NotFoundPage />;
    }

    const CurrentPage = route.component;
    return <CurrentPage />;
}
