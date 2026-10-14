/**
 * @fileoverview Shared configuration and middleware contracts for HTTP host adapters.
 */

import type { CatalogService } from '../types/catalogServiceTypes.ts';
import type { PipelineRegistryService } from '../types/pipelineServiceTypes.ts';

/** Middleware continuation signature used by the Vite and Node adapters. */
export type NextFunction = (error?: unknown) => void;

/** Optional adapter settings; the webhook token is used only for AIStor event authorization. */
export interface PipelineHttpHandlerOptions {
    aistorWebhookToken?: string;
}

/** Already-constructed services and options used by the transport-only HTTP handler. */
export interface PipelineHttpDependencies {
    catalogService: CatalogService;
    options?: PipelineHttpHandlerOptions;
    pipelineService: PipelineRegistryService;
}
