# Catalog adapters

The TypeScript catalog service owns HTTP-facing catalog operations. The
`CATALOG_BACKEND` setting selects Polaris metadata (the default) or Spark
Connect for catalog hierarchy, tables, metadata, and samples. Spark operations
run through `spark_connect_catalog.py` in the configured PySpark runtime. Each
adapter operation accepts one catalog, schema, table, detail, or bounded
sample request and returns one JSON document to the TypeScript service.

## Module ownership

| Module                                                   | Responsibility                                                               |
|----------------------------------------------------------|------------------------------------------------------------------------------|
| `catalogServiceFactory.ts`                               | Selects the configured Polaris or Spark catalog backend                      |
| `polarisCatalogService.ts` and `polarisCatalogConfig.ts` | Polaris-backed catalog hierarchy and connection configuration                |
| `sparkCatalogService.ts` and `spark_connect_catalog.py`  | Spark-backed hierarchy, metadata, and bounded samples                        |
| `catalog_metadata.py`                                    | Catalog discovery, `DESCRIBE` parsing, properties, and object classification |
| `catalog_serialization.py`                               | Type-aware JSON conversion, redaction, and response sizing                   |
| `catalog_sampling.py`                                    | Bounded sample iteration and truncation details                              |
| `catalog_errors.py`                                      | Credential-safe error categories and stderr diagnostics                      |

The Python entry point handles arguments, Spark Connect session management,
operation dispatch, and the JSON stdout boundary. Shared Python helpers depend
on error and serialization helpers; they do not import the CLI entry point.

## Response behavior

Spark detail responses keep ordinary columns, partition column names, and
detailed properties separate. When available metadata cannot identify an
object, its type is `UNKNOWN`. Unsupported extended metadata commands may fall
back to basic column metadata or an `UNKNOWN` object type. Permission,
connection, and unexpected failures remain visible. In Polaris mode, only an
explicitly unsupported Spark detail operation may return Polaris-only metadata.

The adapter writes one JSON document to stdout and controlled diagnostics to
stderr. `SPARK_CATALOG_MAX_RESPONSE_BYTES` bounds its UTF-8 response (default
8 MiB, maximum 64 MiB, matching the Node adapter limit). Samples contain at
most 100 rows and report truncation when row or byte limits remove data. The
Node subprocess timeout covers startup, connection, and query and defaults to
45 seconds.

Credential-bearing property keys are filtered and embedded URI credentials are
redacted before metadata is returned. Table samples use the configured Spark
Connect identity and the existing read-only catalog API. Catalog access is
separate from Spark History monitoring.
