# Test suites

The test tree covers server and web unit behavior, HTTP and discovery
contracts, integration boundaries, and production dependency security checks.
It uses Node 24's built-in test runner with TypeScript type stripping.

## Suite layout

| Path                        | Coverage                                                                                                |
|-----------------------------|---------------------------------------------------------------------------------------------------------|
| `server/unit/<domain>/`     | Server behavior grouped by source area, including pipeline, catalog, persistence, triggers, and runtime |
| `server/contract/<domain>/` | HTTP, API, and discovery contracts grouped by domain                                                    |
| `web/unit/<feature>/`       | Browser-facing pipeline, catalog, registry, and query behavior                                          |
| `integration/`              | Dependency-free run-control integration and repository-managed external service runners                 |
| `security/`                 | Production dependency audit, also run by the container acceptance runner                                |
| `support/`                  | Reusable test environments, fixtures, and data helpers                                                  |

External fixtures belong in the consuming suite's local `testdata/` directory.
Suite-specific assertions stay close to the behavior under test.

## Integration boundaries

The dependency-free base integration suite runs control-plane behavior
in-process. It may use temporary pipeline files and a fake Spark worker for
deterministic lifecycle cases; it does not cover live Spark or Docker
dependencies.

See the [managed integration test guide](integration/README.md) for suite
commands, runner behavior, and cleanup.

Pipeline discovery and execution regression areas are listed in
[`AGENTS.md`](AGENTS.md). Test design and coverage guidance is in the
`testing` skill.
