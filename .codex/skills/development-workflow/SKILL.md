---
name: development-workflow
description: Full checklist for non-Markdown, non-CSS changes under src/ or tests/; CSS changes require a local demo restart.
---

# Development workflow

Use this skill to determine documentation ownership and checklist applicability.
Run the full checklist only when a change set includes at least one changed
file under `src/` or `tests/` whose extension is neither `.md` nor `.css`
(case-insensitive). Markdown and CSS files do not trigger the full checklist.
CSS changes under these directories still require step 6, the local demo
restart. For a CSS-only change set, run only that step. For an atomic multi-file
change, evaluate the complete change set and run the full checklist once after
all changes if any file qualifies; otherwise run step 6 if a CSS file changed.

Module descriptions, architecture, behavior contracts, and ownership maps
belong in localized README.md files. Actionable instructions for agents belong
in localized AGENTS.md files. Source-code and documentation conventions belong
in coding-style. UI guidance belongs in web-development. Server guidance
belongs in server-development. Test design belongs in testing.

## Before inspection

Before coding, identify the affected modules and inspect the nearest applicable
README.md and AGENTS.md for each. As part of every development change, check
whether a durable architecture, module-ownership, API, data-flow, or behavior
contract will become new or change. If so, create or update the closest
applicable README.md in the same change. Update AGENTS.md when actionable
instructions for future agents change. Keep transient task notes and general
coding, design, and testing guidance in their respective skills; avoid
AGENTS.md churn when no agent instruction changes.

## Checklist for qualifying changes

Run these steps in order, one test process at a time:

1. Run lint:

       npm run lint

2. Build:

       npm run build

3. Run the local test suites:

       npm run test:unit:server
       npm run test:unit:web
       npm run test:contract
       npm run test:integration:base

4. Run every managed integration suite. These repository-owned test runners
   may create and remove their own disposable test stacks:

       npm run test:integration:postgres
       npm run test:integration:polaris
       npm run test:integration:spark
       npm run test:integration:container
       npm run test:integration:upgrade

5. Collect the repository-wide Node coverage report:

       node --test --experimental-test-coverage --test-reporter=spec --test-reporter-destination=stdout --test-reporter=lcov --test-reporter-destination=coverage/lcov.info --experimental-strip-types tests/**/*.test.ts

6. Restart the local demo stack:

   Check whether the Control Plane demo container is running:

       docker compose --file compose.dev.yaml ps --status running -q control-plane

   If the command returns a container ID, stop the demo stack:

       npm run demo:down

   Build and start the demo stack:

       npm run demo:up

7. Verify the live demo: record the Control Plane container name and startup
   result; check /health, /ready, and /api/v1/pipelines including response
   bodies; and verify the served JavaScript asset hash matches the local build.
   A local build or HTTP 200 alone is not completion evidence.

For a qualifying change set, run every checklist step even if an earlier step
fails, unless a safety gate explicitly requires stopping. Repair failures and
rerun the complete checklist. If an external condition prevents a step, report
it as blocked and do not claim the change is fully verified.

## Container permissions

These permissions apply whenever the full checklist or CSS-only demo restart
runs.

Integration-test containers may be created only by the repository's managed
integration-test runners. Start the local demo with `npm run demo:up`; if its
Control Plane container is already running, stop the stack with
`npm run demo:down` first. Do not run `docker run`, `docker create`, or raw
`docker compose up` commands for this workflow. Never create containers for
lint, builds, or unrelated tools.

## Report

For a qualifying change set, report lint/build/test results, the demo container,
and live endpoint/asset evidence. For a CSS-only change set, report the demo
restart result. Include a clickable demo link whenever the demo restart runs:
`[Open demo](http://127.0.0.1:8080)`.
Report failures and skipped or blocked evidence explicitly.
