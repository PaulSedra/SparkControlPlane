/**
 * @fileoverview Regression tests for credential redaction at persistence boundaries.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { sanitizeCommand, sanitizeFields, sanitizeText } from '../../../../src/server/utils/sanitization.ts';

test('sanitizeText redacts JSON credentials and quoted key-value assignments', () => {
    const value = [
        '{"password": "json password with spaces", "apiKey": "json-token-value"}',
        "'client_secret': 'quoted secret with spaces'",
        'Authorization: "Bearer quoted-bearer-token"',
    ].join('\n');

    const sanitized = sanitizeText(value);

    assert.doesNotMatch(sanitized, /json password|json-token|quoted secret|quoted-bearer/);
    assert.match(sanitized, /"password": "\[REDACTED\]"/);
    assert.match(sanitized, /'client_secret': '\[REDACTED\]'/);
    assert.match(sanitized, /Authorization: "\[REDACTED\]"/);
});

test('sanitizeFields redacts sensitive keys and caller-supplied known secrets recursively', () => {
    const knownSecret = `database-secret-${crypto.randomUUID()}`;
    const sanitized = sanitizeFields({
        callerMetadata: {
            password: 'metadata-password',
            detail: `diagnostic contains ${knownSecret}`,
        },
        encoded: `{"token": "json-token"}`,
    }, [knownSecret]) as {
        callerMetadata: { password: string; detail: string };
        encoded: string;
    };

    assert.equal(sanitized.callerMetadata.password, '[REDACTED]');
    assert.doesNotMatch(sanitized.callerMetadata.detail, new RegExp(knownSecret));
    assert.doesNotMatch(sanitized.encoded, /json-token/);
});

test('sanitizeCommand redacts both inline credentials and separate flag values', () => {
    assert.deepEqual(sanitizeCommand([
        'spark-pipelines',
        '--password',
        'a password with spaces',
        '--token=inline-token',
        '--verbose',
    ]), [
        'spark-pipelines',
        '--password',
        '[REDACTED]',
        '--token=[REDACTED]',
        '--verbose',
    ]);
});
