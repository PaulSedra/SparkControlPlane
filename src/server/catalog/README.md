# Catalog adapters

The TypeScript catalog service owns HTTP-facing catalog operations. The
`CATALOG_BACKEND` setting selects Polaris metadata (the default) or Spark
Standalone for catalog hierarchy, tables, metadata, and samples. Spark
operations run through `spark_catalog_query.py` as a short-lived
`spark-submit` application. Each adapter operation accepts one catalog,
schema, table, detail, or bounded sample request and returns one JSON document
to the TypeScript service.

## Module ownership

| Module                                                                                   | Responsibility                                                               |
|------------------------------------------------------------------------------------------|------------------------------------------------------------------------------|
| `catalogServiceFactory.ts`                                                               | Selects the configured Polaris or Spark catalog backend                      |
| `polarisCatalogService.ts` and `polarisCatalogConfig.ts`                                 | Polaris-backed catalog hierarchy and connection configuration                |
| `sparkCatalogService.ts`, `sparkStandaloneQueryService.ts`, and `spark_catalog_query.py` | Spark-backed hierarchy, metadata, and bounded samples                        |
| `catalog_metadata.py`                                                                    | Catalog discovery, `DESCRIBE` parsing, properties, and object classification |
| `catalog_serialization.py`                                                               | Type-aware JSON conversion, redaction, and response sizing                   |
| `catalog_sampling.py`                                                                    | Bounded sample iteration and truncation details                              |
| `catalog_errors.py`                                                                      | Credential-safe error categories and stderr diagnostics                      |

The Node adapter starts one `spark-submit` process per bounded query. It uses
the same master URL, driver address, Python runtime, and Spark properties file
as pipeline submissions. The Python entry point handles operation dispatch and
writes the JSON stdout boundary. Pipeline runs submit one application per full
pipeline graph; catalog and preview calls each submit their own short-lived app.
Shared Python helpers depend on error and serialization helpers; they do not
import the CLI entry point.

## Response behavior

Spark detail responses keep ordinary columns, partition column names, and
detailed properties separate. When available metadata cannot identify an
object, its type is `UNKNOWN`. Unsupported extended metadata commands may fall
back to basic column metadata or an `UNKNOWN` object type. Permission,
connection, and unexpected failures remain visible. In Polaris mode, only an
explicitly unsupported Spark detail operation may return Polaris-only metadata.

The adapter writes one JSON document to stdout and diagnostics to stderr.
`SPARK_CATALOG_MAX_RESPONSE_BYTES` sets the Spark catalog backend's query
limit (default 8 MiB, maximum 64 MiB). The Node adapter counts bytes from both
streams toward that limit. Queries that supply no limit use 8 MiB. Samples
contain at most 100 rows and report truncation when row or byte limits remove
data. The Node subprocess timeout covers startup, connection, and query and
defaults to 45 seconds.

Credential-bearing property keys are filtered and embedded URI credentials are
redacted before metadata is returned. Table samples use the configured Spark
application identity and the existing read-only catalog API. Catalog access is
separate from Spark History monitoring.
