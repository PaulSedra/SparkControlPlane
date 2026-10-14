/**
 * @fileoverview Unit coverage for AIStor notification normalization.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDataLoader } from '../../../support/testData.ts';
import { normalizeAistorNotification } from '../../../../src/server/triggers/aistorAdapter.ts';

interface AistorRepresentativeCase {
    encodedObjectKey: string;
    eventName: string;
    fixture: string;
    name: string;
    objectKey: string;
    occurredAt: string;
    versionId: string | null;
}

interface AistorFixture {
    deduplicationInput: Record<string, unknown>;
    emptyInput: Record<string, unknown>;
    malformedInput: Record<string, unknown>;
    multipleRecordsExpected: {
        eventNames: string[];
        length: number;
        objectKeys: string[];
        recordIndexes: string[];
    };
    receivedAt: string;
    representativePayloadCases: AistorRepresentativeCase[];
}

const testData = createTestDataLoader('server/unit');
const fixture = testData.loadData<AistorFixture>('aistor/cases.json');

for (const testCase of fixture.representativePayloadCases) {
    test(`AIStor adapter normalizes ${testCase.name} payload`, () => {
        const [normalized] = normalizeAistorNotification(
            testData.loadData<Record<string, unknown>>(testCase.fixture),
            new Date(fixture.receivedAt),
        );

        assert.equal(normalized?.invalidReason, undefined);
        assert.equal(normalized?.event.source, 'aistor');
        assert.equal(normalized?.event.eventType, 'file.arrived');
        assert.equal(normalized?.event.attributes.recordIndex, '0');
        assert.equal(normalized?.event.attributes.bucket, 'lake');
        assert.equal(normalized?.event.attributes.objectKey, testCase.objectKey);
        assert.equal(normalized?.event.attributes.eventName, testCase.eventName);
        assert.equal(
            normalized?.event.attributes.versionId,
            testCase.versionId ?? undefined,
        );
        assert.equal(normalized?.event.occurredAt, testCase.occurredAt);
        assert.equal(
            (normalized?.event.payload.s3 as { object: { key: string } }).object.key,
            testCase.encodedObjectKey,
        );
    });
}

test('AIStor adapter emits one event per record in a representative notification', () => {
    const normalized = normalizeAistorNotification(
        testData.loadData<Record<string, unknown>>('aistor/multiple-records.json'),
        new Date(fixture.receivedAt),
    );

    assert.equal(normalized.length, fixture.multipleRecordsExpected.length);
    assert.deepEqual(
        normalized.map((item) => item.event.attributes.recordIndex),
        fixture.multipleRecordsExpected.recordIndexes,
    );
    assert.deepEqual(
        normalized.map((item) => item.event.attributes.objectKey),
        fixture.multipleRecordsExpected.objectKeys,
    );
    assert.deepEqual(
        normalized.map((item) => item.event.attributes.eventName),
        fixture.multipleRecordsExpected.eventNames,
    );
});

test('AIStor adapter uses a stable canonical-record deduplication fallback', () => {
    const receivedAt = new Date(fixture.receivedAt);
    const first = normalizeAistorNotification(fixture.deduplicationInput, receivedAt)[0];
    const second = normalizeAistorNotification(fixture.deduplicationInput, receivedAt)[0];
    assert.ok(first);
    assert.ok(second);
    assert.match(first.event.deduplicationKey, /^aistor:lake:incoming\/orders\.json:/);
    assert.equal(first.event.deduplicationKey, second.event.deduplicationKey);
    assert.equal(first.event.eventId, second.event.eventId);
});

test('AIStor adapter records malformed records as invalid canonical events', () => {
    const [normalized] = normalizeAistorNotification(fixture.malformedInput);
    assert.match(normalized?.invalidReason ?? '', /s3\.bucket\.name/);
    assert.equal(normalized?.event.eventType, 'file.arrival.invalid');
    assert.equal(normalized?.event.source, 'aistor');
});

test('an absent AIStor Records array produces no events', () => {
    assert.deepEqual(normalizeAistorNotification(fixture.emptyInput), []);
});
