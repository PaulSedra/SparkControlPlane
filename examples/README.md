# Example pipelines

The `pipelines/` folder contains checked-in examples mounted read-only by the
local demo stack. The getting-started projects write to Spark's built-in
`spark_catalog.default` catalog and use inline sample data, so they need no
external data sources or catalog service.

- `pipelines/getting-started-sql-pipeline/` shows SQL materialized views and their lineage.
- `pipelines/getting-started-python-pipeline/` shows a Python materialized view using Spark 4.2.
- `pipelines/demo-failure-pipeline/` raises an intentional error every time its
  Python materialized view runs.

The demo shares its Spark warehouse, Derby catalog metadata, and pipeline
checkpoints through the `demo-spark-data` volume. `npm run demo:down` stops the
containers and preserves the volumes, including PostgreSQL pipeline history.
To reset all demo data, run
`docker compose --file compose.dev.yaml down --volumes`.
