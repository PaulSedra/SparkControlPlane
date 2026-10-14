/**
 * @fileoverview Composes trigger event ingestion and debounce behind an event
 * source-specific service contract.
 */

import type {
    CanonicalTriggerEvent,
    TriggerIngestionResult,
} from '../types/triggerTypes.ts';
import { createTriggerDebounceCoordinator } from './triggerEventDebounce.ts';
import { createTriggerEventIngestion } from './triggerEventIngestion.ts';
import {
    createTriggerServices,
    type TriggerServices,
    type TriggerServicesOptions,
} from './triggerServices.ts';

/** Dependencies used to normalize and route trigger events. */
export interface TriggerEventServiceOptions extends TriggerServicesOptions {
    /** Shared services supplied by the registry composition root. */
    services?: TriggerServices;
}

/** Event-ingestion operations exposed to the registry service and API. */
export interface TriggerEventService {
    flushDebounces: () => Promise<void>;
    ingestAistorNotification: (payload: unknown) => Promise<TriggerIngestionResult>;
    ingestCanonicalEvent: (event: CanonicalTriggerEvent) => Promise<TriggerIngestionResult>;
    stop: () => void;
}

/**
 * Creates the event boundary for webhook and AIStor paths.
 *
 * The service normalizes provider payloads, routes canonical events to every
 * matching enabled trigger, and coalesces configured file-arrival bursts. It
 * consumes shared delivery services so schedules and event sources record the
 * same delivery and dead-letter evidence. Call `flushDebounces` before a
 * graceful shutdown if pending events must be submitted; `stop` only cancels
 * pending debounce timers.
 */
export function createTriggerEventService(
    options: TriggerEventServiceOptions,
): TriggerEventService {
    const services = options.services ?? createTriggerServices(options);
    const { deliver, runtime } = services;
    const debounce = createTriggerDebounceCoordinator(runtime, deliver);
    const ingestion = createTriggerEventIngestion(runtime, debounce, deliver);
    return {
        flushDebounces: debounce.flush,
        ingestAistorNotification: ingestion.ingestAistorNotification,
        ingestCanonicalEvent: ingestion.ingestCanonicalEvent,
        stop: debounce.stop,
    };
}
