---
name: scp-release
description: Prepare and publish versioned releases for Spark Control Plane.
---

# Spark Control Plane releases

- Confirm the release branches and tags from Git. This repo uses main and
  branch-<major-version>.<minor-version>.
- Use a new version tag for each release. Never move or replace a published
  tag. Update the tracked root package.json version and README badge; do not
  add the gitignored package-lock.json.
- Create the release commit using the commit-messages skill and its 80-column
  limit. Align branch-0.1 with the release commit when the user requests both
  branches to match, and confirm the update is a fast-forward.
- When publication is authorized, push the requested branches and annotated
  tag, create GitHub release notes that summarize user-facing changes, then
  verify the remote refs and release URL. package.json is private, so don't
  publish it to npm.
