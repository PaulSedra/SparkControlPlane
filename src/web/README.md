# Web application

The web application is the React operator interface for pipeline registry,
catalog browsing, source inspection, and individual pipeline runs. It reads
server data through the browser API clients and keeps selected views in the
route or query cache where described below.

## Routes and pages

| Route                                   | Page                   | Purpose                                                                     |
|-----------------------------------------|------------------------|-----------------------------------------------------------------------------|
| `/` and `/pipelines`                    | `JobsAndPipelinesPage` | Pipeline registry and recent runs                                           |
| `/pipelines/:applicationId`             | `PipelinePage`         | Workspace for one pipeline; `applicationId` is the PostgreSQL pipeline UUID |
| `/pipelines/:applicationId/runs/:runId` | `PipelinePage`         | Workspace with the requested run selected                                   |
| `/catalog`                              | `CatalogPage`          | Catalog hierarchy, asset metadata, and bounded samples                      |
| `/workspace`                            | `WorkspacePage`        | Read-only source workspace and global refresh for all pipeline definitions   |
| unmatched routes                        | `NotFoundPage`         | Client-side return to the pipeline registry                                 |

The root and `/pipelines` aliases render the same registry page. The selected
run is synchronized with its route even when it is absent from the recent-run
list; run-picker and Runs-view selections update the URL.

## Registry and run views

The registry contains pipeline name, control-plane ID, version, and spec-path
search, deployment state, node count, last-run time, recent run states, and
deploy/run actions. Registry data currently contains pipeline summaries and
run records; ownership-scope and run-as filters are not available from the API.

Recent-run markers and registry history are status-only. Page monitoring is
keyed by run ID, capped across the page, retried with bounded backoff, and
stopped when runs become terminal or the page unmounts. Monitoring errors are
kept separate from execution outcomes. Registry merges preserve newer run
lifecycle state and full selected-run output.

## Pipeline workspace

The detail page owns route lifecycle, run actions, monitoring, selected-run
state, and preview-node selection. It contains Pipeline and Runs tabs with a
graph, bounded previews, history, node state, logs, and repair interactions.
The Runs view route stays synchronized with the selected run.

Output targets are resolved from pipeline catalog/schema defaults. Spark
catalog table names are loaded once per distinct namespace. An output is
marked `NEW` only when a successful metadata lookup confirms that its table is
absent; failed or unresolved lookups leave it unmarked. Row reads do not
determine table existence.

The details rail shows the shared run-status icon and state label. A selected
failed run's diagnostic summary and expandable captured output appear in the
graph footer. When live monitoring reaches a terminal state, the selected
run's full persisted record is refreshed so its output replaces a status-only
snapshot. Routine run-start, progress, and completion notices are absent from
the registry; submission failures remain actionable.

Graph, table, performance, sample-data, trigger, and registry component
behavior is described in [components/README.md](components/README.md).

## Source areas

| Area                                            | Responsibilities                                                |
|-------------------------------------------------|-----------------------------------------------------------------|
| `routes/` and `pages/`                          | Route definitions and page composition                          |
| `api/`                                          | Browser catalog and pipeline registry clients                   |
| `query/`                                        | Query cache, query keys, and pipeline mutations                 |
| `components/catalog/`                           | Catalog browsing, metadata, selection, and sample views         |
| `components/jobs-and-pipelines/`                | Registry controls, filters, rows, and run monitoring            |
| `components/pipeline/`                          | Pipeline workspace and its graph, run, table, and trigger views |
| `components/workspace/`                         | Read-only source workspace                                      |
| `components/graph-canvas/` and `components/ui/` | Shared visual and interaction primitives                        |
| `utils/`                                        | Cross-feature pipeline asset, timing, and presentation helpers  |
| `styles/`                                       | Shared tokens, lifecycle status styling, and browser styles     |

Shared API and persistence behavior is described in
[`../server/README.md`](../server/README.md). Visual guidance is split across
the typography, layout and spacing, state semantics, color, and icon references
in the [web-development skill](../../.codex/skills/web-development/SKILL.md).
