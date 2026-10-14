# Server metrics

The server observability module is a small, process-local registry implemented
in [`observability.ts`](./observability.ts). It does not use `prom-client` and
does not persist values in PostgreSQL. The standalone server exposes the
registry at `GET /metrics` by returning `prometheusMetrics()`.

## Endpoint and lifecycle

The response uses the Prometheus text exposition content type:

```text
text/plain; version=0.0.4; charset=utf-8
```

Values belong to the process being scraped. Counters and duration totals reset
when that process restarts, and each server instance has its own registry. A
Prometheus deployment should therefore scrape every instance and perform any
cross-instance aggregation externally. Metrics currently have no labels,
timestamps, or `# HELP` lines.

The renderer emits a trailing newline. With no registered values it returns a
single newline. Within the response, counters are emitted first, then gauges,
then duration observations; insertion order is preserved within each group.

Metric names are supplied by the callers and are not validated, escaped, or
deduplicated by the registry. Callers must use valid Prometheus metric names
and must not register the same name as more than one metric kind.

## Metric kinds and wire format

| API                                 | Meaning                                                                                                                                                                              | Prometheus output                                                                                    |
|-------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|
| `incrementMetric(name, value = 1)`  | Adds `value` to a process-local total. The implementation permits signed values, so callers must use non-negative increments when the metric is intended to be a Prometheus counter. | `# TYPE <name> counter` followed by `<name> <total>`                                                 |
| `setMetric(name, value)`            | Replaces the current process-local value.                                                                                                                                            | `# TYPE <name> gauge` followed by `<name> <value>`                                                   |
| `observeDuration(name, durationMs)` | Adds one duration observation. Negative values are clamped to zero.                                                                                                                  | `<name>_count` is emitted as a counter and `<name>_sum` as a gauge; both values are in milliseconds. |

Duration observations are accumulators, not native Prometheus histograms or
summaries: there are no buckets, quantiles, or `# TYPE <name> histogram` /
`summary` lines. An average for one scrape can be calculated as
`<name>_sum / <name>_count` when the count is non-zero. The `_sum` value is
declared as a gauge by the current renderer even though it is cumulative.

For example, a response can look like this (values are illustrative):

```text
# TYPE control_plane_submissions_total counter
control_plane_submissions_total 12
# TYPE control_plane_runs_succeeded_total counter
control_plane_runs_succeeded_total 9
# TYPE control_plane_queued_runs gauge
control_plane_queued_runs 2
# TYPE control_plane_oldest_queued_age_seconds gauge
control_plane_oldest_queued_age_seconds 18.5
# TYPE control_plane_queue_wait_ms_count counter
control_plane_queue_wait_ms_count 9
# TYPE control_plane_queue_wait_ms_sum gauge
control_plane_queue_wait_ms_sum 4210
```

## Metrics currently emitted

### Counters

| Metric                                     | Meaning                                                                                                                           |
|--------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------|
| `control_plane_submissions_total`          | Successful run-submission service calls after persistence accepts or replays the submission.                                      |
| `control_plane_cancellations_total`        | Successful cancellation requests returned by persistence.                                                                         |
| `control_plane_recovery_attempts_total`    | Lease-recovery passes started by the run coordinator.                                                                             |
| `control_plane_recovery_successes_total`   | Lease-recovery passes completed without an error.                                                                                 |
| `control_plane_claims_total`               | Queued or recoverable runs successfully claimed by a worker.                                                                      |
| `control_plane_forced_termination_total`   | Active local children force-terminated during shutdown after their run state is detached and their lease is released.             |
| `control_plane_spark_start_failures_total` | Failures from the local Spark pipeline command path before it returns an execution result. This is narrower than all failed runs. |
| `control_plane_runs_succeeded_total`       | Terminal run completions whose `SUCCEEDED` state was applied to persistence.                                                      |
| `control_plane_runs_failed_total`          | Terminal run completions whose `FAILED` state was applied to persistence.                                                         |
| `control_plane_runs_canceled_total`        | Terminal run completions whose `CANCELED` state was applied to persistence.                                                       |
| `control_plane_runs_timed_out_total`       | Terminal run completions whose `TIMED_OUT` state was applied to persistence.                                                      |

### Gauges

| Metric                                    | Unit    | Meaning                                                                                                                                                                                                       |
|-------------------------------------------|---------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `control_plane_queued_runs`               | runs    | Queue depth from the latest operational snapshot.                                                                                                                                                             |
| `control_plane_active_runs`               | runs    | Active-run value most recently written by an operational snapshot or by the local run coordinator while a run is claimed or finalized. The process-local renderer does not aggregate values across processes. |
| `control_plane_stuck_runs`                | runs    | Stuck active-run count from the latest operational snapshot.                                                                                                                                                  |
| `control_plane_oldest_queued_age_seconds` | seconds | Age of the oldest queued run at the latest operational snapshot. It is `0` when no queued run exists.                                                                                                         |

### Duration accumulators

| Base name                       | Unit         | Observation                                                                                                                                                                              |
|---------------------------------|--------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `control_plane_queue_wait_ms`   | milliseconds | One observation per claimed run, measured from the persisted run start timestamp to worker claim.                                                                                        |
| `control_plane_run_duration_ms` | milliseconds | One observation per completed execution path, measured from the persisted run start timestamp to its terminal timestamp, or to the current time when no terminal timestamp is available. |

Each base name above produces `<base>_count` and `<base>_sum` as described in
[Metric kinds and wire format](#metric-kinds-and-wire-format). The values are
process-local and reset on restart.
