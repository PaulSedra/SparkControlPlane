# Container change instructions

Read the [container configuration](README.md) and deployment guide before
changing the application image, Compose files, or container adapters.

- Keep container-specific executable adapters under `docker/`. The health
  probe consumes the server's `/health` route; keep its behavior and response
  contract in `src/server/runtime/`.
- Create disposable containers only through the repository-owned integration
  test runners.
- Keep server behavior in the server modules and deployment facts in the
  README or deployment guide.
