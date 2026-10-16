# Repository instructions

- Before changing a module, read its nearest `README.md` and `AGENTS.md`.
- Follow [the development workflow](.codex/skills/development-workflow/SKILL.md)
  for documentation ownership and verification. Run its checklist only when a
  change set includes a file under `src/` or `tests/` whose extension is
  neither `.md` nor `.css`.
- Follow [the coding style guide](.codex/skills/coding-style/SKILL.md) for source and Markdown conventions.
- Create test infrastructure only through the repository's managed integration
  runners.
- A `.css` change under `src/` or `tests/` requires the demo restart even when
  no other changed file qualifies for the full checklist. If the demo Control
  Plane container is running, run `npm run demo:down`, then run
  `npm run demo:up`.
