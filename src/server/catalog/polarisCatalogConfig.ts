/**
 * @fileoverview Resolves optional Polaris catalog PostgreSQL settings while
 * preserving the control-plane connection as a fallback.
 */

import { integerValue } from '../config/configValues.ts';
import type { PostgresConfig, PostgresTlsMode } from '../types/postgresConfigTypes.ts';

/** Default schema used by the Polaris catalog metadata tables. */
export const POLARIS_SCHEMA = 'polaris_schema';

const POLARIS_CONNECTION_ENVIRONMENT_NAMES = [
    'POLARIS_POSTGRES_DATABASE',
    'POLARIS_POSTGRES_HOST',
    'POLARIS_POSTGRES_PASSWORD',
    'POLARIS_POSTGRES_PORT',
    'POLARIS_POSTGRES_USER',
] as const;

const CONTROL_PLANE_CONNECTION_ENVIRONMENT_NAMES = [
    'POSTGRES_DATABASE',
    'POSTGRES_HOST',
    'POSTGRES_PASSWORD',
    'POSTGRES_PORT',
    'POSTGRES_USER',
] as const;

/**
 * Resolves Polaris PostgreSQL settings from explicit variables, a supplied
 * control-plane fallback, or matching control-plane environment values.
 *
 * Explicit Polaris values win per field, the database defaults to `polaris`,
 * TLS settings are validated with certificate pairing, and absent connection
 * configuration returns `undefined` so callers can report catalog access as
 * unavailable rather than failing unrelated pipeline startup.
 */
export function loadPolarisPostgresConfig(
    environment: NodeJS.ProcessEnv = process.env,
    fallback?: PostgresConfig,
    schemaOverride?: string,
): PostgresConfig | undefined {
    const hasExplicitConnection = POLARIS_CONNECTION_ENVIRONMENT_NAMES.some((name) =>
        environment[name]?.trim(),
    );
    const hasControlPlaneConnection = CONTROL_PLANE_CONNECTION_ENVIRONMENT_NAMES.some((name) =>
        environment[name]?.trim(),
    );
    if (fallback == null && !hasExplicitConnection && !hasControlPlaneConnection) {
        return undefined;
    }

    const tlsMode = (environment.POLARIS_POSTGRES_SSLMODE?.trim() ||
        fallback?.tlsMode ||
        environment.POSTGRES_SSLMODE?.trim() ||
        'require').toLowerCase();
    if (!isPostgresTlsMode(tlsMode)) {
        throw new Error(
            'POLARIS_POSTGRES_SSLMODE must be disable, require, verify-ca, or verify-full.',
        );
    }

    const ca = environment.POLARIS_POSTGRES_SSLROOTCERT?.trim() ||
        fallback?.ca ||
        environment.POSTGRES_SSLROOTCERT?.trim();
    const cert = environment.POLARIS_POSTGRES_SSLCERT?.trim() ||
        fallback?.cert ||
        environment.POSTGRES_SSLCERT?.trim();
    const key = environment.POLARIS_POSTGRES_SSLKEY?.trim() ||
        fallback?.key ||
        environment.POSTGRES_SSLKEY?.trim();
    if ((tlsMode === 'verify-ca' || tlsMode === 'verify-full') && ca == null) {
        throw new Error(
            'POLARIS_POSTGRES_SSLROOTCERT is required when POLARIS_POSTGRES_SSLMODE verifies certificates.',
        );
    }
    if ((cert == null) !== (key == null)) {
        throw new Error(
            'POLARIS_POSTGRES_SSLCERT and POLARIS_POSTGRES_SSLKEY must be provided together.',
        );
    }

    return {
        ca,
        cert,
        database: environment.POLARIS_POSTGRES_DATABASE?.trim() || 'polaris',
        host: requiredValue(
            environment,
            fallback?.host,
            'POLARIS_POSTGRES_HOST',
            'POSTGRES_HOST',
        ),
        key,
        password: requiredValue(
            environment,
            fallback?.password,
            'POLARIS_POSTGRES_PASSWORD',
            'POSTGRES_PASSWORD',
        ),
        port: integerValue(
            environment.POLARIS_POSTGRES_PORT,
            'POLARIS_POSTGRES_PORT',
            fallback?.port ?? integerEnvironmentValue(environment.POSTGRES_PORT) ?? 5432,
            1,
            65535,
        ),
        schema: schemaValue(
            schemaOverride || environment.POLARIS_POSTGRES_SCHEMA || POLARIS_SCHEMA,
        ),
        tlsMode,
        user: requiredValue(
            environment,
            fallback?.user,
            'POLARIS_POSTGRES_USER',
            'POSTGRES_USER',
        ),
    };
}

function schemaValue(value: string): string {
    const schema = value.trim();
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
        throw new Error(
            'POLARIS_POSTGRES_SCHEMA must contain only lowercase letters, digits, and underscores.',
        );
    }
    return schema;
}

function requiredValue(
    environment: NodeJS.ProcessEnv,
    fallback: string | undefined,
    ...names: string[]
): string {
    for (const name of names) {
        const value = environment[name]?.trim();
        if (value) {
            return value;
        }
    }
    if (fallback?.trim()) {
        return fallback.trim();
    }
    throw new Error(`${names.join(' or ')} is required for Polaris PostgreSQL access.`);
}

function integerEnvironmentValue(rawValue: string | undefined): number | undefined {
    if (rawValue == null || rawValue.trim() === '') {
        return undefined;
    }
    if (!/^\d+$/.test(rawValue.trim())) {
        return undefined;
    }
    return Number.parseInt(rawValue, 10);
}

function isPostgresTlsMode(value: string): value is PostgresTlsMode {
    return ['disable', 'require', 'verify-ca', 'verify-full'].includes(value);
}
