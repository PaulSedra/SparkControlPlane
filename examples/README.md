# Example pipelines

The `pipelines/` folder contains checked-in examples mounted read-only by the
local demo stack. Both projects write to Spark's built-in
`spark_catalog.default` catalog and use inline sample data, so they need no
external data sources or catalog service.

- `pipelines/getting-started-sql-pipeline/` shows SQL materialized views and their lineage.
- `pipelines/getting-started-python-pipeline/` shows a Python materialized view using Spark 4.2.

The demo's Spark catalog and warehouse live in the Spark container's temporary
storage. `npm run demo:down` removes that container and its output tables; the
PostgreSQL volume keeps pipeline and run history between demo sessions.
