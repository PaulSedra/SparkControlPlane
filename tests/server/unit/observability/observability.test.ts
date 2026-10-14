/**
 * @fileoverview Unit coverage for error messages and structured observability.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    publicErrorMessage,
    sanitizeCommand,
} from '../../../../src/server/utils/sanitization.ts';
import { logStructured } from '../../../../src/server/utils/structuredLogging.ts';
import { withEnvironment } from '../../../support/testEnvironment.ts';

test('structured logs redact seeded secrets from fields and message text', () => {
    const line = captureStructuredLog('test_event', {
        password: 'seeded-value',
        message: 'token=seeded-value',
    });
    assert.doesNotMatch(line, /seeded-value/);
    assert.match(line, /REDACTED/);
});

test('sanitizes configured secrets, PEM values, bearer tokens, and commands', async () => {
    await withEnvironment({
        AISTOR_WEBHOOK_TOKEN: 'seeded-aistor-token',
        POSTGRES_PASSWORD: 'seeded-environment-secret',
        POSTGRES_SSLROOTCERT:
            '-----BEGIN CERTIFICATE-----\nseeded-certificate-value\n-----END CERTIFICATE-----',
    }, () => {
        const line = captureStructuredLog('sanitization_test', {
            command: sanitizeCommand([
                'python',
                '--password=seeded-environment-secret',
            ]),
            environment: {
                POSTGRES_PASSWORD: 'seeded-environment-secret',
            },
            message: 'Bearer seeded-bearer-token configured=seeded-aistor-token',
            pem: process.env.POSTGRES_SSLROOTCERT,
        });
        const error = publicErrorMessage(new Error(
            'password=seeded-environment-secret certificate=-----BEGIN KEY-----\nseeded\n-----END KEY-----',
        ));
        assert.doesNotMatch(line, /seeded-environment-secret|seeded-certificate-value|seeded-bearer-token|seeded-aistor-token/);
        assert.doesNotMatch(error, /seeded-environment-secret|seeded/);
        assert.match(line, /REDACTED/);
        assert.match(error, /REDACTED/);
    });
});

function captureStructuredLog(
    event: string,
    fields: Record<string, unknown>,
): string {
    const originalLog = console.log;
    let line = '';
    console.log = (...args: unknown[]) => {
        line = String(args[0] ?? '');
    };
    try {
        logStructured(event, fields);
    } finally {
        console.log = originalLog;
    }
    return line;
}
