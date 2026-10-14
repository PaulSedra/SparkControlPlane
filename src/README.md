# Source architecture

Spark Control Plane discovers, visualizes, deploys, runs, repairs, and inspects
mounted Apache Spark Declarative Pipeline projects. PostgreSQL owns durable
control-plane state, and Spark Connect provides pipeline execution and bounded
data access.

## System boundaries

- Pipeline specifications and matching libraries are discovered recursively
  below `PIPELINES_DIR`.
- PostgreSQL owns immutable pipeline UUIDs and durable deployment, queue, run,
  cancellation, lease, event, node, and audit state. The YAML `name` is mutable
  display metadata.
- SQL declarations and text-pattern lineage are parsed locally. Python outputs
  and dynamic flows are discovered through PySpark's
  `GraphElementRegistry`.
- The standalone Node server serves production traffic. The Vite plugin is a
  development adapter around shared server services.
- Spark Connect is the execution and bounded preview endpoint. The optional
  Spark History proxy provides historical Spark application details; persisted
  PostgreSQL records remain authoritative for pipeline run history.

## Data flow

1. Discover mounted specifications and matching project libraries.
2. Parse SQL lineage and capture Python graph registration through PySpark.
3. Serve registry and detail data to React through the shared API.
4. Persist deployment state and accept asynchronous, idempotent run requests.
5. Claim queued work independently of the HTTP request and execute it through
   the installed PySpark Pipelines CLI.
6. Persist current run projections and append-only events.
7. Query selected datasets through bounded Spark Connect adapters.

## Source areas

| Area                    | Responsibilities                                                                | Architecture details                                   |
|-------------------------|---------------------------------------------------------------------------------|--------------------------------------------------------|
| `server/`               | HTTP, registry services, persistence, triggers, catalog access, Spark execution | [Server README](server/README.md)                      |
| `server/pipeline/`      | Pipeline discovery, graph construction, run coordination, Spark adapters        | [Pipeline README](server/pipeline/README.md)           |
| `server/catalog/`       | Polaris discovery, Spark catalog enrichment, bounded table samples              | [Catalog README](server/catalog/README.md)             |
| `server/triggers/`      | Event ingestion, schedules, shared delivery, dead-letter recovery               | [Trigger README](server/triggers/README.md)            |
| `server/observability/` | Process-local metrics registry and Prometheus text rendering                    | [Observability README](server/observability/README.md) |
| `shared/`               | Cross-boundary serializable contracts and status vocabularies                   | [Shared README](shared/README.md)                      |
| `web/`                  | Browser routes, pages, queries, and feature composition                         | [Web README](web/README.md)                            |
| `web/components/`       | Shared UI primitives and feature component ownership                            | [Components README](web/components/README.md)          |

The closest module README describes its architecture and behavior contracts.
The corresponding `AGENTS.md` contains instructions for agents changing that
area.
