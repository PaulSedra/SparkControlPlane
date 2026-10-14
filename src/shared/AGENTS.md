# Shared contract change instructions

Read the [shared contracts](README.md) and relevant server or web module
documentation before changing a shared value or type.

- Define each status value in its owning domain module and import it directly;
  keep the status modules without a shared barrel.
- Preserve the dependency direction documented in the README.
- Keep PostgreSQL and API schemas compatible with serialized values. Update
  migrations and all affected consumers together when a persisted contract
  changes.
- Describe changed contract behavior in the README; keep only agent change
  instructions here.
