# Container configuration

The root Dockerfile and Compose files define the Spark Control Plane
application image and deployment configurations. Container-specific
executable adapters live in this directory. The deployment contract and
environment settings are documented in [`../docs/deployment.md`](../docs/deployment.md).

`control-plane-healthcheck.mjs` calls the standalone server's `/health` route
and returns its HTTP result as the container process status. Route behavior and
response ownership remain in `src/server/runtime/`.

`compose.dev.yaml` is the one-command local demo stack. It supplies disposable
PostgreSQL, Spark Connect, and Control Plane services with local defaults and
mounts `examples/pipelines/` read-only. It selects Spark's built-in catalog and
keeps the Spark warehouse in the container's temporary storage. Start it with
`npm run demo:up`; see the root README for the browser URL and stop command.

Disposable integration infrastructure is defined under `integration/`. The
repository-owned runners manage its temporary services, inputs, runtime values,
and cleanup; see [`../tests/integration/README.md`](../tests/integration/README.md).
