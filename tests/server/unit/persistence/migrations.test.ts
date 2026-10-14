/**
 * @fileoverview Unit coverage for PostgreSQL migration schema selection.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool } from 'pg';
import { applyMigrations } from '../../../../src/server/persistence/migrations.ts';

test('migrations default to the public schema', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'spark-control-plane-migrations-'));
    const queries: string[] = [];
    const client = {
        query: async (query: string) => {
            queries.push(query);
            return { rowCount: 0, rows: [] };
        },
        release: () => undefined,
    };
    const pool = { connect: async () => client } as unknown as Pool;

    try {
        await applyMigrations(pool, directory);
        assert.ok(queries.includes('CREATE SCHEMA IF NOT EXISTS "public"'));
        assert.ok(queries.includes('SET search_path TO "public"'));
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});
