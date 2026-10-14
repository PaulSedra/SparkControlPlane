/**
 * @fileoverview Applies ordered, checksummed PostgreSQL migrations without
 * mutating already-applied versions.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';

import type { AppliedMigration } from './migrationTypes.ts';

/**
 * Applies ordered SQL migrations and verifies every existing checksum.
 *
 * Each new migration runs in its own transaction and is recorded only after
 * the SQL commits, so a failed migration can be retried without a false
 * applied marker. Already-applied versions are not rerun; a changed file is
 * rejected as drift instead. The function creates/uses the requested schema,
 * holds one client for the sequence, and releases that client before
 * returning, while the caller retains ownership of the pool.
 */
export async function applyMigrations(
    pool: Pool,
    directory = path.join(import.meta.dirname, 'migrations'),
    schema = 'public',
): Promise<AppliedMigration[]> {
    const migrationFiles = (await fs.readdir(directory))
        .filter((file) => /^\d+[-_][a-z0-9-]+\.sql$/i.test(file))
        .sort((left, right) => left.localeCompare(right));
    const client = await pool.connect();
    try {
        const quotedSchema = quoteIdentifier(schema);
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quotedSchema}`);
        await client.query(`SET search_path TO ${quotedSchema}`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version text PRIMARY KEY,
                checksum text NOT NULL,
                applied_at timestamptz NOT NULL
            )
        `);
        const applied: AppliedMigration[] = [];
        for (const file of migrationFiles) {
            const versionMatch = file.match(/^(\d+)[-_]/);
            if (versionMatch == null) {
                continue;
            }
            const version = versionMatch[1];
            const sql = await fs.readFile(path.join(directory, file), 'utf8');
            const checksum = await sha256(sql);
            const existing = await client.query<{ checksum: string }>(
                'SELECT checksum FROM schema_migrations WHERE version = $1',
                [version],
            );
            if (existing.rowCount !== 0) {
                if (existing.rows[0]?.checksum !== checksum) {
                    throw new Error(`Migration checksum mismatch for version ${version}.`);
                }
                applied.push({ checksum, version });
                continue;
            }

            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query(
                    'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ($1, $2, NOW())',
                    [version, checksum],
                );
                await client.query('COMMIT');
                applied.push({ checksum, version });
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            }
        }
        return applied;
    } finally {
        client.release();
    }
}

function quoteIdentifier(value: string): string {
    if (!/^[a-z_][a-z0-9_]*$/.test(value)) {
        throw new Error('Migration schema name is invalid.');
    }
    return `"${value}"`;
}

async function sha256(value: string): Promise<string> {
    const crypto = await import('node:crypto');
    return crypto.createHash('sha256').update(value).digest('hex');
}
