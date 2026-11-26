# Container configuration

The root Dockerfile and Compose files define the Spark Control Plane
application image and deployment configurations. Container-specific
executable adapters live in this directory. The deployment contract and
environment settings are documented in [`../docs/deployment.md`](../docs/deployment.md).

`control-plane-healthcheck.mjs` calls the standalone server's `/health` route
and returns its HTTP result as the container process status. Route behavior and
response ownership remain in `src/server/runtime/`.

The root `Dockerfile` copies the runtime named by `JAVA_RUNTIME_IMAGE` into the
Control Plane image. It defaults to Eclipse Temurin 21 JRE. Managed integration
runs use digest-pinned Java runtimes for both the Control Plane and Spark test
containers.

`compose.dev.yaml` starts PostgreSQL, a local Spark Standalone master and worker,
and the Control Plane. It mounts `examples/pipelines/` read-only and shares the
demo warehouse, Derby metastore, and checkpoint volume between the Control
Plane and worker. The worker advertises 2 cores and each Spark app is capped at
2 executor cores. Pipeline runs, catalog queries, and previews submit to the
local master. The demo Spark image uses Eclipse Temurin 21 JRE. See the root
README for the browser address and stop command.

Disposable integration infrastructure is defined under `integration/`. The
repository-owned runners manage its temporary services, inputs, runtime values,
and cleanup; see [`../tests/integration/README.md`](../tests/integration/README.md).
