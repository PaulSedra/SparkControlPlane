# Web change instructions

Read the [web application architecture](README.md) and the nearest component
README.md and AGENTS.md before changing a page or feature.

- Preserve route aliases, route parameters, and selected-run URL behavior
  described in the README.
- Keep cross-feature asset projections in `src/web/utils/`. Components do not
  import helpers from another component folder.
- Preserve loading, empty, error, accessibility, and keyboard behavior at each
  page and component boundary.
- Keep API and persistence contracts in the server documentation. Put changed
  browser behavior facts in README.md and agent change rules in AGENTS.md.
