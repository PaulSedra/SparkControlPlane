/**
 * @fileoverview Static route registry for the application shell and pipeline
 * deep links.
 */

import CatalogPage from '../pages/CatalogPage';
import JobsAndPipelinesPage from '../pages/JobsAndPipelinesPage';
import PipelinePage from '../pages/PipelinePage';
import WorkspacePage from '../pages/WorkspacePage';
import type { AppRoute } from './routeTypes.ts';

/** Routes rendered by the application shell, in matching order. */
export const APP_ROUTES: AppRoute[] = [
    {
        component: JobsAndPipelinesPage,
        label: 'Jobs & Pipelines',
        path: '/',
        title: 'Jobs & Pipelines | Control Plane',
    },
    {
        component: JobsAndPipelinesPage,
        label: 'Jobs & Pipelines',
        path: '/pipelines',
        title: 'Jobs & Pipelines | Control Plane',
    },
    {
        component: CatalogPage,
        label: 'Catalog',
        path: '/catalog',
        title: 'Catalog | Control Plane',
    },
    {
        component: WorkspacePage,
        label: 'Workspace',
        path: '/workspace',
        title: 'Workspace | Control Plane',
    },
    {
        component: PipelinePage,
        label: 'Pipeline detail',
        path: '/pipelines/:applicationId',
        title: 'Control Plane',
    },
    {
        component: PipelinePage,
        label: 'Pipeline run detail',
        path: '/pipelines/:applicationId/runs/:runId',
        title: 'Control Plane',
    },
];
