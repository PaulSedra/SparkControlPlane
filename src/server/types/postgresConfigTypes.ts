/**
 * @fileoverview PostgreSQL connection settings shared by the runtime and
 * persistence adapters.
 */

/** TLS policy accepted by the PostgreSQL client. */
export type PostgresTlsMode =
    | 'disable'
    | 'require'
    | 'verify-ca'
    | 'verify-full';

/** Fully resolved PostgreSQL connection configuration. */
export interface PostgresConfig {
    ca?: string;
    cert?: string;
    database: string;
    host: string;
    key?: string;
    password: string;
    port: number;
    schema: string;
    tlsMode: PostgresTlsMode;
    user: string;
}
