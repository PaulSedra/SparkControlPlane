/**
 * @fileoverview PostgreSQL connection options shared by integration tests.
 */

import { loadPostgresConfig } from '../../src/server/config/postgresConfig.ts';
import type { PostgresConfig } from '../../src/server/types/postgresConfigTypes.ts';

/** TLS options passed to the `pg` pool by live integration tests. */
type PostgresSsl = false | { ca: string | undefined; cert: string | undefined; key: string | undefined; rejectUnauthorized: boolean };

/**
 * Converts application configuration into a test pool configuration while
 * pinning the requested schema in the connection options.
 */
export function postgresPoolConfig(config: PostgresConfig, schema = config.schema, ssl: PostgresSsl = config.tlsMode === 'disable' ? false : { ca: config.ca, cert: config.cert, key: config.key, rejectUnauthorized: config.tlsMode !== 'require' }) {
    return { database: config.database, host: config.host, options: `-c search_path=${schema}`, password: config.password, port: config.port, ssl, user: config.user };
}

/** Returns whether direct PostgreSQL integration prerequisites exist. */
export function isLivePostgresTestEnabled(): boolean {
    try {
        loadPostgresConfig();
        return true;
    } catch {
        return false;
    }
}
