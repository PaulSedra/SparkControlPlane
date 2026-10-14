# Integration test change instructions

Read the [integration suite overview](README.md) and
[`../README.md`](../README.md) before changing a managed suite.

- Use the repository npm integration-test runners. Do not start managed stacks
  manually or replace their endpoint, image, credential, or cleanup settings.
- Do not claim live service coverage from the dependency-free base suite.
- Keep disposable integration containers within the repository-owned runners.
