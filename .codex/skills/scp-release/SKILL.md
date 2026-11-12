---
name: scp-release
description: Prepare and publish versioned releases for Spark Control Plane.
---

# Spark Control Plane releases

- Confirm the release branches and tags from Git. This repo uses main and
  branch-<major-version>.<minor-version>.
- Use a new version tag for every release. Never move or replace a published
  tag. Before committing, align the tracked release metadata:
  - Set the root package.json version. If package-lock.json is tracked, set
    both its top-level and packages[""] versions to match. Never add an
    ignored or untracked lockfile.
  - Set the root Dockerfile default APP_VERSION and every Compose APP_VERSION
    build argument to the release version.
  - Update a static version badge in README.md. Keep a dynamic GitHub
    latest-release badge as-is; publishing the release updates it.
  Search tracked files for the previous version and review every hit. Update
  release metadata while preserving historical notes and dependency versions.
- Create the release commit using the commit-messages skill and its 80-column
  limit. Align branch-0.1 with the release commit when the user requests both
  branches to match, and confirm the update is a fast-forward.
- When publication is authorized, push the requested branches and annotated
  tag, create GitHub release notes that summarize user-facing changes, then
  verify the remote refs and release URL. package.json is private, so don't
  publish it to npm.
