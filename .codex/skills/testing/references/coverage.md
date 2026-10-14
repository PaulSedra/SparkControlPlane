# Coverage workflow

## Runner

Node 24's built-in test runner can collect line, branch, and function coverage without adding a second test framework. Keep the repository's existing test flags and add `--experimental-test-coverage`:

```powershell
node --test --test-concurrency=1 --experimental-strip-types --experimental-test-coverage tests/web/unit/catalogNavigation.test.ts
```

For a focused server or web change, replace the test path with the smallest relevant test file or group. The report includes only modules loaded by that run. A focused report is useful for a changed module; it is not a repository-wide coverage claim.

To constrain the report to a source area, use Node's coverage include/exclude flags where needed:

```powershell
node --test `
  --test-concurrency=1 `
  --experimental-strip-types `
  --experimental-test-coverage `
  --test-coverage-include='src/server/**/*.ts' `
  tests/server/unit/*.test.ts tests/server/contract/*.test.ts
```

Do not add a global 100% threshold merely to make the command look strict. The repository contains intentionally boundary-driven code and entrypoints that are not all loaded by one local test group. Use the report to inspect the changed module and changed lines.

## Changed-code gate

After the focused coverage run:

1. Identify changed production files with `git diff --name-only` and the corresponding changed line ranges.
2. Confirm that every newly added executable line is covered in the focused report or by a deliberately selected higher-level suite.
3. Inspect branch and function coverage for new conditional paths, retry/terminal behavior, and error handling; line coverage alone can miss an untested branch.
4. If a changed line is not reachable in the local suite, add the smallest contract, integration, Spark, or container test that observes it. If the path truly requires an external dependency, state that boundary and run it when authorized.
5. Never turn coverage off, exclude changed files, or reduce the threshold to conceal an uncovered path. Exclude only generated files, test support, fixtures, or a documented process entrypoint that is outside the chosen scope.

## Suggested focused commands

Use the command that matches the changed boundary:

```powershell
# Web utility/component-adjacent logic
node --test --test-concurrency=1 --experimental-strip-types --experimental-test-coverage tests/web/unit/*.test.ts

# Server logic
node --test --test-concurrency=1 --experimental-strip-types --experimental-test-coverage tests/server/unit/*.test.ts

# HTTP/discovery contract behavior
node --test --test-concurrency=1 --experimental-strip-types --experimental-test-coverage tests/server/contract/*.test.ts

# Dependency-free lifecycle behavior
node --test --test-concurrency=1 --experimental-strip-types --experimental-test-coverage tests/integration/*.test.ts
```

Coverage collection is separate from the build/typecheck gate. Still run `npm run build` and `npm run lint`; a coverage report does not prove type safety, bundling, API compatibility, or a live dependency boundary.
