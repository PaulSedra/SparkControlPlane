/**
 * @fileoverview Unit coverage for PostgreSQL environment configuration.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPostgresConfig } from '../../../../src/server/config/postgresConfig.ts';

const requiredEnvironment = {
    POSTGRES_DATABASE: 'control_plane',
    POSTGRES_HOST: 'postgres.internal',
    POSTGRES_PASSWORD: 'test-password',
    POSTGRES_SSLMODE: 'disable',
    POSTGRES_USER: 'control_plane',
};

test('PostgreSQL schema defaults to public', () => {
    assert.equal(loadPostgresConfig(requiredEnvironment).schema, 'public');
});

test('PostgreSQL schema accepts an explicit override', () => {
    assert.equal(
        loadPostgresConfig({ ...requiredEnvironment, POSTGRES_SCHEMA: 'control_plane' }).schema,
        'control_plane',
    );
});
