# Source change instructions

Read the [source architecture](README.md), then read the nearest module
README.md and AGENTS.md before changing code.

- Keep HTTP transport, shared services, persistence, and Spark execution in
  their documented source areas.
- Import shared values and types from their owning modules. Do not add a status
  barrel or re-export bindings from another source file.
- Preserve `UNKNOWN` as an unverified terminal node outcome, distinct from a
  confirmed failure.
- Keep architecture, ownership, and behavior facts in README.md. Update this
  file only when agent change instructions need to change.
