# Server change instructions

Read the [server architecture](README.md), the applicable module README and
AGENTS.md, and the API contract in `docs/api-characterization.md` before
changing server behavior.

- Keep transport-independent rules in services and HTTP translation in the
  shared API adapter. Preserve the production `/api/v1`, `/health`, and `/ready`
  contracts described in the server README and API documentation.
- Preserve service lifecycle ownership: standalone-created services are
  initialized and stopped by the server; injected services remain caller-owned.
- Keep Docker probe executables under `docker/`; the standalone server owns
  probe routes and their responses.
- Preserve PostgreSQL as the authority for control-plane state and retain
  migration compatibility and non-destructive startup behavior.
- Keep pipeline, catalog, trigger, and observability responsibilities in their
  documented module areas. Update a module README when its facts or behavior
  contract changes.
- Keep module change instructions here or in the closest nested AGENTS.md.
