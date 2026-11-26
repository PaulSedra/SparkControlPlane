/** @fileoverview Unit coverage for shared bounded configuration value helpers. */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
    boundedIntegerValue,
    boundedPositiveInteger,
} from '../../../../src/server/config/configValues.ts';

test('bounded integers default invalid values and clamp configured bounds', () => {
    assert.equal(boundedIntegerValue(Number.NaN, 30, 1, 86_400), 30);
    assert.equal(boundedIntegerValue(0, 30, 1, 86_400), 1);
    assert.equal(boundedIntegerValue(90_000, 30, 1, 86_400), 86_400);
});

test('bounded integers convert units after clamping', () => {
    assert.equal(boundedIntegerValue(90_000, 30_000, 1, 86_400, 1_000), 86_400_000);
});

test('positive bounded integers default invalid values and cap valid values', () => {
    assert.equal(boundedPositiveInteger(undefined, 4, 8), 4);
    assert.equal(boundedPositiveInteger(0, 4, 8), 4);
    assert.equal(boundedPositiveInteger(2.5, 4, 8), 4);
    assert.equal(boundedPositiveInteger(9, 4, 8), 8);
});
