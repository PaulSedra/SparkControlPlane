/**
 * @fileoverview In-memory persistence aggregate used by unit and contract tests.
 */

import type { ControlPlanePersistence } from '../../src/server/types/pipelinePersistenceTypes.ts';
import { createInMemoryAuditPersistence } from './inMemoryAuditPersistence.ts';
import { createInMemoryPipelinePersistence } from './inMemoryPipelinePersistence.ts';
import { createInMemoryRunPersistence } from './inMemoryRunPersistence.ts';
import { createInMemoryTriggerPersistence } from './inMemoryTriggerPersistence.ts';

/** Configuration for the deterministic in-memory persistence adapter. */
export interface InMemoryPersistenceOptions {
    now?: () => number;
}

/**
 * Composes isolated persistence adapters for unit and contract tests. Each
 * adapter keeps its domain state private while sharing the injected clock.
 */
export function createInMemoryPersistence(
    options: InMemoryPersistenceOptions = {},
): ControlPlanePersistence {
    const now = options.now ?? (() => Date.now());
    const auditPersistence = createInMemoryAuditPersistence({ now });
    const pipelineStore = createInMemoryPipelinePersistence();
    const runStore = createInMemoryRunPersistence({
        getDeploymentForRun: pipelineStore.getDeploymentForRun,
        now,
    });
    const triggerPersistence = createInMemoryTriggerPersistence({ now });
    let ready = false;

    return {
        ...pipelineStore.persistence,
        ...runStore,
        ...auditPersistence,
        ...triggerPersistence,
        kind: 'memory',
        async initialize() {
            ready = true;
        },
        isReady: () => ready,
        async shutdown() {
            ready = false;
        },
    };
}
