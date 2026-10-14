# Test change instructions

Read the [test-suite map](README.md), the nearest test instructions, and the
`testing` skill before changing tests.

- Test observable behavior, contracts, payloads, state transitions, and
  user-visible results. Start with the narrowest observable layer.
- Keep domain assertions in the nearest suite and fixtures in that suite's
  `testdata/` directory.
- For pipeline discovery and execution changes, preserve coverage for nested
  and duplicate specs, SQL/Python graphs, stable IDs and deployed hashes,
  asynchronous/idempotent submissions, run modes, failure output, recovery,
  and repair behavior.
- Use the real mounted project and installed PySpark runtime for manifest
  behavior. Use repository-managed runners for Spark and container boundaries;
  do not replace a managed boundary with a local fake.
- An HTTP success response does not prove Spark execution succeeded; inspect
  persisted run state and the execution result.
