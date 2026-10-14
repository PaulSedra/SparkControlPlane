/**
 * @fileoverview Resolves direct PostgreSQL environment configuration and
 * rejects unsupported file-based credential settings.
 */

import { integerValue } from './configValues.ts';
import type { PostgresConfig, PostgresTlsMode } from '../types/postgresConfigTypes.ts';

const FILE_BASED_CONFIGURATION_NAMES = [
    'POSTGRES_PASSWORD_FILE',
    'POSTGRES_TLS_CA_FILE',
    'POSTGRES_TLS_CERT_FILE',
    'POSTGRES_TLS_KEY_FILE',
    'POSTGRES_SSLROOTCERT_FILE',
    'POSTGRES_SSLCERT_FILE',
    'POSTGRES_SSLKEY_FILE',
] as const;

/**
 * Loads the direct-environment PostgreSQL contract used by control-plane
 * persistence.
 *
 * File-based secret and certificate variables are rejected deliberately so a
 * deployment cannot appear configured while the runtime silently ignores a
 * mounted file. TLS verification modes require their CA value, client
 * certificate and key must arrive together, and the schema/port are bounded
 * before adapters receive the configuration. The returned strings are
 * normalized for validation, while the caller remains responsible for pool
 * creation and shutdown.
 */
export function loadPostgresConfig(
    environment: NodeJS.ProcessEnv = process.env,
): PostgresConfig {
    rejectFileBasedConfiguration(environment);

    const tlsMode = (optionalValue(environment, 'POSTGRES_SSLMODE') ?? 'require').toLowerCase();
    if (!isPostgresTlsMode(tlsMode)) {
        throw new Error(
            'POSTGRES_SSLMODE must be disable, require, verify-ca, or verify-full.',
        );
    }

    const ca = optionalValue(environment, 'POSTGRES_SSLROOTCERT');
    const cert = optionalValue(environment, 'POSTGRES_SSLCERT');
    const key = optionalValue(environment, 'POSTGRES_SSLKEY');
    if ((tlsMode === 'verify-ca' || tlsMode === 'verify-full') && ca == null) {
        throw new Error(
            'POSTGRES_SSLROOTCERT is required when POSTGRES_SSLMODE verifies certificates.',
        );
    }
    if ((cert == null) !== (key == null)) {
        throw new Error(
            'POSTGRES_SSLCERT and POSTGRES_SSLKEY must be provided together as direct environment values.',
        );
    }

    return {
        ca,
        cert,
        database: requiredValue(environment, 'POSTGRES_DATABASE'),
        host: requiredValue(environment, 'POSTGRES_HOST'),
        key,
        password: requiredValue(environment, 'POSTGRES_PASSWORD'),
        port: integerValue(
            environment.POSTGRES_PORT,
            'POSTGRES_PORT',
            5432,
            1,
            65535,
        ),
        schema: schemaValue(environment.POSTGRES_SCHEMA),
        tlsMode,
        user: requiredValue(environment, 'POSTGRES_USER'),
    };
}

function rejectFileBasedConfiguration(environment: NodeJS.ProcessEnv): void {
    const configuredNames = FILE_BASED_CONFIGURATION_NAMES.filter((name) =>
        environment[name]?.trim(),
    );
    if (configuredNames.length > 0) {
        throw new Error(
            `${configuredNames.join(', ')} is not supported. Provide PostgreSQL credentials and certificate values directly through environment variables.`,
        );
    }
}

function schemaValue(value: string | undefined): string {
    const schema = value?.trim() || 'public';
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
        throw new Error(
            'POSTGRES_SCHEMA must contain only lowercase letters, digits, and underscores, and start with a letter or underscore.',
        );
    }
    return schema;
}

function isPostgresTlsMode(value: string): value is PostgresTlsMode {
    return ['disable', 'require', 'verify-ca', 'verify-full'].includes(value);
}

function requiredValue(
    environment: NodeJS.ProcessEnv,
    name: string,
): string {
    const value = environment[name];
    if (value != null && value.trim() !== '') {
        return value;
    }
    throw new Error(`${name} is required.`);
}

function optionalValue(
    environment: NodeJS.ProcessEnv,
    name: string,
): string | undefined {
    const value = environment[name]?.trim();
    return value == null || value === '' ? undefined : value;
}
