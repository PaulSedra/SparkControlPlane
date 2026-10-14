# Pipeline change instructions

Read the [pipeline discovery and execution architecture](README.md), the
[server architecture](../README.md), and the nearest nested agent instructions
before changing this module.

- Preserve the module and adapter ownership map in the README. Generic YAML
  decoding belongs in `yamlParser.ts`, pipeline model normalization in
  `pipelineSpecParser.ts`, and trigger mapping/binding in
  `yamlTriggerConfiguration.ts`.
- Do not execute mounted Python pipeline code unless the project is trusted.
- Preserve deployed-source hash checks, run-specific source snapshots, and the
  single CLI process per run ID. A recovered CLI identity must be inspected;
  never submit that run a second time.
- Keep unverified terminal outcomes distinct from confirmed failures. Preserve
  confirmed node states and captured output during recovery.
- Resolve flow selections to output datasets before passing targets to Spark.
  Keep manifest, log, sample, and subprocess output within their existing
  bounds.
- Preserve lease heartbeat cleanup, run-success dependency idempotency, and
  terminal node projection behavior described in the README.
- For Python adapter changes, compile changed files with the repository `.venv`
  and inspect the manifest/API behavior when registration changes.
