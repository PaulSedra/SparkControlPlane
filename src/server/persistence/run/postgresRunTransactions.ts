/**
 * @fileoverview Shared transaction boundary for PostgreSQL run mutations.
 */

import type { Pool, PoolClient } from 'pg';

/**
 * Runs one run-persistence operation in a single PostgreSQL transaction.
 * Callbacks retain control of lock ordering and return only after their
 * mutations and event records are ready to commit; failures roll back before
 * the pooled client is released.
 */
export async function withRunTransaction<T>(
    pool: Pool,
    operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        try {
            await client.query('ROLLBACK');
        } catch {
            // Preserve the operation error if PostgreSQL also rejects rollback.
        }
        throw error;
    } finally {
        client.release();
    }
}
