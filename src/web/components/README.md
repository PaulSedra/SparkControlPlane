# Shared web component architecture

This directory contains shared visual primitives and feature components for
the operator interface. Page and route ownership is described in
[`../README.md`](../README.md).

## Shared primitives

| Component                      | Responsibility                                                                                                                           |
|--------------------------------|------------------------------------------------------------------------------------------------------------------------------------------|
| `AppIcon`                      | Renders shared Lucide icons for brand, action, toolbar, input, node-type, and empty-state use with semantic sizing and accessible labels |
| `DataAssetIcon`                | Uses native Lucide `Table2` for tables and overlays `Eye` at lower right for views throughout Catalog and pipeline UI                    |
| `StatusIcon`                   | Maps waiting, canceled, failed, running, succeeded, and unknown states to shared icons and accessible labels                             |
| `StatusPill` and `StatusBadge` | Combine status text with `StatusIcon`                                                                                                    |
| `EmptyState`                   | Presents valid zero-data and waiting states; actionable errors use notices                                                               |
| `GraphCanvas`                  | Owns graph pan, zoom, transformed viewport, pointer drag, wheel behavior, accessible canvas label, and optional footer                   |

## Pipeline graph and panels

`PipelineAssetGraph` renders the declared or monitoring-derived DAG inside
`GraphCanvas`. It owns graph geometry, asset nodes, selection, type labels,
status, durations, output records, empty state, asset count, and selected-run
diagnostics. Status appears in an in-card strip; hover and selection change the
node border without replacing that strip. Pointer exit clears the highlight
without changing selection. A queued run shows “Waiting for resources” at the
run level; queued nodes have no status icon until Spark reports node progress.

The graph uses transitive reduction and deterministic ordering. Active
connectors are painted after overlapping edges. Hovering the left half of a
node highlights incoming paths and arrowheads; hovering the right half
highlights outgoing paths. Edges do not respond independently to hover.

Graph display projection collapses flows that read only pipeline tables into
direct table-to-target connectors. Flows remain visible for external or
unresolved sources; mixed inputs connect internal tables directly to the target
alongside the flow. Streaming-table status is derived from incoming flows before
this projection.

External inputs appear as compact informational cards left of the Flow
they support, separated from adjacent asset columns by the regular column gap.
A URI input is labeled "External Source"; an external table reference is
labeled "External Table". An external input appears once per graph level with
arrows to each supported Flow at that level. Stacked cards leave room for each
type label and a gap before the next label. If an external card or its label
overlaps an upstream asset node, the graph reserves a lane and shifts upstream
columns left. When neither overlaps, the external card can share a column with
upstream nodes.
External cards have no status, duration, output metrics, focus, or actions, and
hovering one highlights all its outgoing connectors.

Output nodes confirmed absent from Spark catalog metadata show a plain orange
`NEW` label above the node type and accessible text that says "new to Spark".
Spark-derived output-record, row, byte, and stage values remain static `-`
placeholders. Run start times and durations come from persisted application run
records. Failed selected-run diagnostics appear in a red summary and expandable
stdout/stderr panel in the graph footer; the details rail contains only its
shared status icon and label.

The `external-source` asset kind identifies external inputs. Registry
node type labels come from the single `pipelineNodeTypeLabel` mapping in
`pipelineCatalogPresentation.ts`. Raw SVG in graph components draws connector
geometry rather than icons.

## Pipeline workspace components

| Area            | Responsibility                                                                                                                                                                               |
|-----------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `PipelineView`  | Composes Pipeline and Runs tabs, derives declared asset operations, selects graph or runs content, and forwards selection, preview, source-navigation, catalog-presence, and monitoring data |
| `PipelinePage`  | Owns route lifecycle, run actions, monitoring, and selected preview node                                                                                                                     |
| `graph/`        | DAG rendering, topology, layout, edges, and graph styles                                                                                                                                     |
| `bottom-panel/` | Tables, Performance, Sample Data, resizing, and shared table primitives                                                                                                                      |
| `runs/`         | Run history, timeline, selection, duration bars, and task labels                                                                                                                             |
| `triggers/`     | Pipeline trigger UI and `usePipelineTriggers`                                                                                                                                                |
| `hooks/`        | Pipeline-wide controller and selection hooks                                                                                                                                                 |

`PipelineControls` renders deployment, run, stop, run-selection, and
selected-table refresh controls. Pipeline sharing is not available in the web
UI.

`PipelineView` keeps its graph-only flow projection private. Shared asset
utilities retain complete declared execution operations. The sample-data tab
appears for a selected graph or table node and is removed when Tables or
Performance is selected. Flow nodes remain available for graph lineage and
streaming-table status, but are excluded from Tables and Performance rows,
counts, and graph asset count.

`PipelineTablesPanel` owns resizable Tables and Performance views and the
temporary Sample Data tab. `PipelineTablesView` owns persistent
search/type/status filters and table rows/actions. `PipelinePerformanceView`
owns run timing and metric placeholders. `PipelineSampleDataView` owns the
bounded query and its loading, error, and empty states and mounts only while the
sample tab is active. `BottomPanelResizer`, `PanelTable`, and `AssetNameCell`
are shared panel primitives.

`RunsView` owns run-history tables, timeline, selection, durations, and task
labels. Its temporal positioning preserves chronological clarity,
scrollability, and accessible table structure.

`PipelinePage` supplies the selected-run timing clock to `PipelineDetailsRail`.
Total duration advances once per second while run timing is active and uses a
persisted end time when available. Compact entity states use badges; prominent
connection states use pills.

## Registry components

`useJobsAndPipelinesController` composes registry queries, local search/tag/
favorite filters, and row actions. Pure filter and run-action state transitions
are handled by adjacent helpers. Run monitors are keyed by run ID, capped
across the page, retried with bounded backoff, and stopped when terminal or
unmounted. Monitoring errors do not represent execution outcomes or create
run-result notices. Registry and run-cache merges preserve lifecycle progress
and full run output so selected-run diagnostics remain available.

Registry polling reads the saved PostgreSQL snapshot and never discovers file
changes. The `/workspace` page provides one global **Refresh all pipelines**
action that repulls the complete mounted folder and applies its YAML
definitions; trigger Pause and Resume remain effective until that refresh
reapplies YAML `enabled` values.

The registry API currently provides pipeline summaries and run records. It
does not provide the fields needed for working job, ownership-scope, or run-as
filters. Trigger-created run outcomes appear in run history. Dataset access
remains server-mediated and bounded.

Visual guidance is split across the typography, layout and spacing, state
semantics, color, and icon references in the
[web-development skill](../../../.codex/skills/web-development/SKILL.md).
