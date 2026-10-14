---
name: coding-style
description: Single source for source-code style, formatting, naming, imports, comments, docstrings, and documentation conventions across this repository.
---

# Coding style

This is the only skill that defines source-code style. Use Google's published
language guide as the general source of truth and follow the repository rules
below. The web-development skill owns visual design values; the testing skill
owns test design and fixture organization. Do not put application architecture
or runtime contracts here.

Use the relevant Google guide for the language being changed:

- TypeScript: https://google.github.io/styleguide/tsguide.html
- JavaScript: https://google.github.io/styleguide/jsguide.html
- Python: https://github.com/google/styleguide/blob/gh-pages/pyguide.md
- Shell: https://google.github.io/styleguide/shellguide.html
- HTML and CSS: https://google.github.io/styleguide/htmlcssguide.html
- JSON: https://google.github.io/styleguide/jsoncstyleguide.xml
- Markdown: https://google.github.io/styleguide/docguide/style.html

For TypeScript documentation, also use
https://google.github.io/styleguide/docguide/best_practices.html. Verify a live
guide when network access is available and link the applicable rule when
explaining a style recommendation. Do not let style override a stronger
functional requirement.

## Naming, imports, and formatting

Use the selected language guide for identifier and file naming, import
grouping/order, whitespace, punctuation, and line wrapping. Keep repository
formatters and linters as the executable check; do not invent a second local
formatting scheme or suppress a rule just to preserve a preferred layout.
Choose names that communicate the value or operation, avoid unexplained
abbreviations, and follow the language guide's casing conventions.

## Source-file organization

Arrange implementation modules from top to bottom:

1. Imports.
2. Module constants and other module-level configuration.
3. Module-local types and interfaces.
4. Exported or main functions.
5. Major internal functions.
6. Small helpers.

Keep public entrypoints, components, hooks, factories, and controllers above
the functions they delegate to. Put mappers, normalization, validation,
cloning, layout math, and other small helpers near the bottom. Import shared
contracts from canonical modules instead of redefining them beside an
implementation.

Apply this order to TypeScript, TSX, JavaScript, and Python implementation
modules under src, scripts, and tests. Omit sections that do not apply.
Type-only, generated, migration, and fixture-only files are exempt.

## Documentation and comments

- Add @fileoverview when a module's purpose, boundary, or important dependency
  is not clear from its filename. Place it after a copyright or license header
  and before the first import.
- Document every top-level TypeScript or JavaScript export with JSDoc. Document
  every public Python function or class with the caller contract it provides;
  keep an obvious pure helper's docstring concise.
- Explain the behavior a caller cannot infer from the signature: purpose,
  state/lifecycle, triggers, side effects, failure behavior, caller
  obligations, and relevant retry, ordering, idempotency, serialization,
  bounds, or runtime requirements.
- For UI exports, include state ownership and lifecycle, what starts or resets
  work, loading/error/empty behavior, accessibility guarantees, side effects,
  and meaningful constraints when those details are hidden by the component
  boundary. For hooks and controllers, explain coordination behavior and
  caller obligations.
- For process adapters, document the input and output shape, which stream
  carries machine-readable data, bounds, runtime prerequisites, failure
  behavior, and any version-specific assumptions callers must preserve.
- Keep obvious pure functions and data types concise. Do not repeat type
  annotations or obvious parameter names. UI docs may omit @param and @return
  when the signature already says everything callers need.
- A comment that only says creates, returns, renders, or is used by another
  subsystem is incomplete when behavior or constraints are hidden.
- Use ordinary implementation comments to explain why a non-obvious choice
  exists. Keep them beside the invariant or boundary; do not narrate JSX or
  restate CSS/property names.
- Keep comments accurate and update them with the code in the same change.
- Keep operational documentation aligned with actual runtime behavior and
  machine-readable input/output contracts.

## README and agent instructions

- Use `README.md` for human-facing module purpose, responsibilities,
  architecture, behavior and API contracts, configuration, and usage.
- Use `AGENTS.md` for actionable instructions that apply when an agent changes
  files in that directory, such as invariants to preserve, file ownership, and
  local procedures.
- Avoid repeating detailed module facts. Link from `AGENTS.md` to the nearest
  README when an instruction depends on architecture or behavior described
  there; brief context may remain when it makes the instruction clear.
- Create a README when it has useful human-facing content; do not add an empty
  document just to pair it with an `AGENTS.md`.
