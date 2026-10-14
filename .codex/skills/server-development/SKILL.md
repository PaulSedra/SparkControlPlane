---
name: server-development
description: General backend implementation guidance for APIs, persistence, process boundaries, configuration, and runtime behavior in Spark Control Plane.
---

# Server development

Use for backend implementation and debugging. Read src/server/README.md and
src/server/AGENTS.md, plus the closest nested README.md and AGENTS.md, before
changing a server module. Keep endpoint, service, persistence, and pipeline
architecture details in the local READMEs rather than duplicating them here.

Preserve documented request and response contracts. Validate untrusted input at
the boundary, keep queries and process output bounded, make persistence and
retry behavior explicit, and report failures through the established API
contract. Read configuration from the environment or the repository's
configuration layer; do not hard-code host-specific endpoints or credentials.

When a server feature launches a process or uses a Python runtime adapter,
maintain a bounded input/output contract, keep diagnostics off machine-readable
stdout, use the configured runtime, and preserve child-process cancellation and
cleanup behavior. Do not add a parallel service or ad hoc probe when the
existing subsystem can provide the behavior.

Python helper scripts should accept arguments with argparse, write one
machine-readable JSON result to stdout, send diagnostics to stderr, validate
identifiers, enforce time/query/collection/payload bounds, and exit nonzero on
failure. Exercise the helper directly before its HTTP route. Keep adapter- and
module-specific facts in the closest server README.md and change instructions
in its AGENTS.md.

Use coding-style for source conventions, testing for test design, and
development-workflow for mandatory checks and app refresh.
