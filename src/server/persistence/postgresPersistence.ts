/**
 * @fileoverview Composes the PostgreSQL persistence adapters that back the
 * control-plane domains and owns their shared pool lifecycle.
 */

import type { Pool, PoolConfig } from 'pg';
import { Pool as PgPool } from 'pg';
import { applyMigrations } from './migrations.ts';
import { createPostgresAuditPersistence } from './postgresAuditPersistence.ts';
import { createPostgresPipelinePersistence } from './postgresPipelinePersistence.ts';
import { createPostgresRunPersistence } from './run/postgresRunPersistence.ts';
import type { PostgresConfig } from '../types/postgresConfigTypes.ts';
import type { ControlPlanePersistence } from '../types/pipelinePersistenceTypes.ts';
import { createPostgresTriggerPersistence } from './triggerPersistence.ts';

/** Construction options for the PostgreSQL persistence adapter. */
export interface PostgresPersistenceOptions {
    migrationsDirectory?: string;
    pool?: Pool;
}

/**
 * Creates the aggregate PostgreSQL persistence adapter for all control-plane
 * domains.
 *
 * Pipeline, run, audit, and trigger repositories share one pool so their
 * transactions observe the same schema and migration state. `initialize`
 * verifies the connection, applies ordered migrations, and reconciles expired
 * run leases; `shutdown` closes the pool only when this factory created it.
 */
export function createPostgresPersistence(
    config: PostgresConfig,
    options: PostgresPersistenceOptions = {},
): ControlPlanePersistence {
    const pool = options.pool ?? new PgPool(poolConfig(config));
    const pipelinePersistence = createPostgresPipelinePersistence(pool);
    const runPersistence = createPostgresRunPersistence(pool, config.password);
    const auditPersistence = createPostgresAuditPersistence(pool, config.password);
    const triggerPersistence = createPostgresTriggerPersistence(pool);
    let ready = false;

    return {
        ...auditPersistence,
        ...pipelinePersistence,
        ...runPersistence,
        ...triggerPersistence,
        kind: 'postgresql',
        async initialize() {
            await pool.query('SELECT 1');
            await applyMigrations(pool, options.migrationsDirectory, config.schema);
            await runPersistence.reconcileExpiredLeases();
            ready = true;
        },
        isReady: () => ready,
        async shutdown() {
            ready = false;
            if (options.pool == null) {
                await pool.end();
            }
        },
    };
}

function poolConfig(config: PostgresConfig): PoolConfig {
    const ssl = config.tlsMode === 'disable'
        ? false
        : {
            ca: config.ca,
            cert: config.cert,
            key: config.key,
            rejectUnauthorized: config.tlsMode !== 'require',
        };
    return {
        database: config.database,
        host: config.host,
        max: 10,
        options: `-c search_path=${config.schema}`,
        password: config.password,
        port: config.port,
        ssl,
        user: config.user,
    };
}
