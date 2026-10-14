---
name: testing
description: General test design, test-data, coverage, and verification guidance for Spark Control Plane.
---

# Testing

Read tests/README.md for this repository's test-suite layout and ownership, and
tests/AGENTS.md for test-change instructions. Use this skill for test design
and coverage; use development-workflow for the mandatory commands that run
after every change.

## Test design

- Name each test so its scenario and expected behavior are clear without
  opening the body.
- Test observable responsibilities, public behavior, state transitions,
  payloads, and user-visible results. Avoid tests that only lock down private
  helper calls or implementation structure unless that structure is a
  documented contract.
- Keep each test focused enough that a failing name identifies the broken
  behavior. Split cases with independently meaningful behaviors.
- Preserve meaningful edge cases, including zero, absent values, duplicates,
  filters, retries, and idempotency.
- Use scenario tables only when cases exercise the same behavior. Do not hide
  materially different contracts in one data-driven table.
- Keep a test file's @fileoverview and imported production modules aligned to
  the same responsibility.
- For time, subprocess, retry, lease, or restart behavior, assert the persisted
  or observable condition the next operation actually requires.

## Test data

Store deterministic matrices of serializable inputs and expected outputs or
errors in the nearest suite's testdata directory. Use YAML for human-authored
configuration cases and JSON for wire payloads or machine-shaped records.
Keep TypeScript responsible for invoking production code, conversions,
assertions, setup, cleanup, and service wiring; give fixtures typed shapes at
the test boundary. Represent error matching with serializable strings or
structured fields, not functions or regular expressions.

Do not create a global testdata directory for suite-specific fixtures. Avoid
externalizing a small case when its adapter would be more complex than the
test.

## Coverage

Use the coverage reference for runner flags and changed-code coverage review.
Exercise every newly developed executable path or explain and verify the
higher-level boundary that reaches it. Inspect branch and function coverage
for new conditions, retries, terminal behavior, and error handling. Do not
disable coverage, exclude changed files, or lower thresholds to conceal an
uncovered path. Do not claim full-repository coverage from a focused run.
