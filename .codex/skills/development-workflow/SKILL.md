---
name: development-workflow
description: Mandatory checklist for every Spark Control Plane change, including local checks, integration suites, and existing-container refresh.
---

# Development workflow

Use this skill for every change set. Run the complete checklist below after
each change, including documentation, configuration, skills, and AGENTS files.
Do not skip a step because the change is small or belongs to a particular
language or module. If several files make up one atomic change, finish that
change and run the checklist before starting another independent change.

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

## Checklist for every change

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

6. Refresh the existing application container in place (if the ps1 file exists):

       pwsh -NoProfile -File .codex/skills/development-workflow/scripts/refresh-container.ps1 -Apply

   Do not create or replace a container. The script must resolve the existing
   Spark Control Plane service, preserve its read-only /app/pipelines mount,
   copy the current build and runtime source, and restart that same container.
   If it cannot identify one existing app container, stop and report the
   blocker; do not run compose up or create a replacement.

7. Verify the live refresh: record the exact container name and restart result;
   check /health, /ready, and /api/v1/pipelines including response bodies; and
   verify the served JavaScript asset hash matches the local build. A local
   build or HTTP 200 alone is not completion evidence.

Run every checklist step even if an earlier step fails, unless a safety gate
explicitly requires stopping. Repair failures and rerun the complete checklist.
If an external condition prevents a step, report it as blocked and do not claim
the change is fully verified.

## Container permissions

Container creation is permitted only inside the repository's managed
integration-test runners. The application refresh is an in-place copy and
restart of its existing container. Never create containers for lint, builds, or unrelated tools. Never use docker run,
docker create, docker compose up, or docker-compose up for this workflow.

## Report

For each change, report lint/build/test results, the refreshed container and
live endpoint/asset evidence.
Report failures and skipped or blocked evidence explicitly.
