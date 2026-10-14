# Component change instructions

Read the [component architecture](README.md), the
[web application architecture](../README.md), and the web-development skill's
design-system reference before changing shared or feature components.

- Use `AppIcon` for Lucide icons, `StatusIcon` for lifecycle icons and colors,
  and `EmptyState` for valid zero-data or waiting states.
- Keep graph and panel responsibilities in their documented owners. Shared
  projections belong in `src/web/utils/`; feature components do not import
  helpers from another component folder.
- Preserve accessible labels, keyboard behavior, responsive states, and the
  graph and run-detail behavior described in the README.
- Keep unsupported Spark metric placeholders static and preserve persisted run
  output through cache updates.
- Update the README when component responsibilities or rendered behavior
  change; keep actionable change instructions here.
