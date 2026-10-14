/**
 * @fileoverview Route table and current-route contracts for the React shell.
 */

import type { ComponentType } from 'react';

/** Static route metadata used to render and resolve an application page. */
export interface AppRoute {
    component: ComponentType;
    label: string;
    path: string;
    title: string;
}

/** Route plus decoded path parameters matched for the current location. */
export interface RouteMatch {
    params: Record<string, string>;
    route: AppRoute;
}

/** Browser location and optional application route match. */
export interface CurrentRoute {
    match?: RouteMatch;
    pathname: string;
    search: string;
}
