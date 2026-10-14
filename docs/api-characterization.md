# API contract characterization

This document freezes the versioned HTTP contract implemented by the Vite
development server and the standalone production server. The browser client,
container, and integration tests use the same `/api/v1` resource routes.

## Versioned pipeline registry routes

| Route                                                | Allowed method | Success                                              | Characterized failures                                                                                                          |
|------------------------------------------------------|----------------|------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------|
| `/api/v1/pipelines`                                  | `GET`          | `200` with a paginated pipeline list                 | Invalid pagination is `400`; other methods return `405` and `Allow: GET`.                                                       |
| `/api/v1/pipelines/{pipelineId}`                     | `GET`          | `200` with pipeline detail                           | Unknown ID is `404`; other methods return `405`.                                                                                |
| `/api/v1/pipelines/{pipelineId}/deploy`              | `POST`         | `200` with deployed detail                           | Unknown ID is `404`; other methods return `405`.                                                                                |
| `/api/v1/pipelines/{pipelineId}/runs`                | `GET`, `POST`  | `200` with run history or `202` with an accepted run | Invalid submission is `400`; stale source, missing deployment, and idempotency conflicts are `409`; other methods return `405`. |
| `/api/v1/runs/{runId}`                               | `GET`          | `200` with current run state                         | Unknown ID is `404`.                                                                                                            |
| `/api/v1/runs/{runId}/status`                        | `GET`          | `200` with the compact run status                    | Unknown ID is `404`.                                                                                                            |
| `/api/v1/runs/{runId}/events`                        | `GET`          | `200` with paginated run events                      | Unknown ID is `404`; invalid pagination is `400`.                                                                               |
| `/api/v1/runs/{runId}/cancel`                        | `POST`         | `200` with the updated run                           | Unknown ID is `404`; other methods return `405`.                                                                                |
| `/api/v1/pipelines/{pipelineId}/nodes/{nodeId}/data` | `GET`          | `200` with a bounded sample                          | Unknown pipeline or node is `404`; unconfigured Spark or query failure is `500`; other methods return `405`.                    |
| `/api/v1/pipelines/{pipelineId}/source?file=...`     | `GET`          | `200` with read-only source content                  | Missing or unknown file is `400` or `404`; other methods return `405`.                                                          |

Run submission is persisted with `QUEUED` status before the `202` response.
The response includes `Location` and `Retry-After: 1`. An idempotent replay
returns the original run and `Idempotent-Replayed: true`; reuse for a different
request returns `409`. Excess work remains queued, and a source change after
deployment prevents submission.

`PipelineDetail.spec.timeoutSeconds` reflects the optional top-level
`timeout_seconds` value from pipeline YAML. Each submitted `PipelineRun` carries
that value when configured; when omitted, the run has no automatic timeout.

All JSON errors contain a stable broad `code` and a human-readable `message`.

Run submissions accept `incremental`, `full-refresh-all`, `dry-run`,
`refresh-selected`, and `full-refresh-selected` modes, plus the existing
`repair-failed` mode. The two selected-refresh modes require `nodeNames`; the
control plane validates those names against the discovered pipeline graph and
persists them with the run.

If Spark's final run outcome cannot be verified, the run and any node still
active at finalization report `UNKNOWN`. Node outcomes already confirmed by
Spark remain unchanged.

When `SPARK_HISTORY_URL` is configured, `/spark-api/*` proxies Spark History
API requests to `/api/v1/*` for historical Spark applications and their
execution details. This is separate from pipeline run history, which is read
from the control plane's persisted PostgreSQL run records.

## Catalog routes

The catalog page does not read pipeline manifests. `CATALOG_BACKEND` selects
the hierarchy source: `polaris` (default) reads the read-only Polaris
PostgreSQL persistence schema; `spark` reads the catalog directly through
Spark Connect. Both modes use these lazy routes:

| Route                                                                 | Source                                                                                                                  | Result                                                                                      |
|-----------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| `GET /api/v1/catalogs`                                                | Polaris mode: `polaris_schema.entities`; Spark mode: Spark Connect                                                      | Catalog names                                                                               |
| `GET /api/v1/catalogs/{catalog}/schemas`                              | Polaris mode: recursive namespace query; Spark mode: Spark Connect                                                      | Nested namespace paths                                                                      |
| `GET /api/v1/catalogs/{catalog}/schemas/{schema}/tables`              | Polaris mode: table-like entities; Spark mode: Spark Connect                                                            | Tables and views                                                                            |
| `GET /api/v1/catalogs/{catalog}/schemas/{schema}/tables/{table}`      | Spark mode: Spark Connect; Polaris mode: entity properties merged with available Spark `DESCRIBE TABLE EXTENDED` output | Location, extended metadata properties (including expanded `Table Properties`), and columns |
| `GET /api/v1/catalogs/{catalog}/schemas/{schema}/tables/{table}/data` | Spark Connect `SELECT * ... LIMIT n`                                                                                    | A bounded sample of at most 100 rows                                                        |

Set `CATALOG_BACKEND=spark` when Polaris metadata is unavailable and Spark
Connect owns the catalog hierarchy. In Spark 4.2, the built-in catalog is
`spark_catalog` and its default database is `default`.

Set `POLARIS_POSTGRES_DATABASE=polaris` and, when needed, the other
`POLARIS_POSTGRES_*` overrides. If the Polaris database shares the control-plane
PostgreSQL connection, the adapter reuses the `POSTGRES_*` connection values and
uses `polaris_schema` by default.
