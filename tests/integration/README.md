# Managed integration tests

Repository-owned runners manage disposable dependencies, temporary pipeline
inputs, runtime values, and cleanup for PostgreSQL, Polaris, Spark Connect,
application-container, and migration-upgrade suites.

Use the npm scripts in the root README to run a suite. The runners own service
startup, dynamic endpoint and credential values, readiness checks, test
selection, and cleanup. The PostgreSQL suite checks persistence, the Polaris
suite checks Polaris catalog integration, the Spark suite checks live Spark
Connect behavior and runs a sample pipeline in `spark_catalog.default`, the
container suite audits production dependencies and checks the application
runtime, and the upgrade suite checks migration behavior.

These managed suites verify external boundaries. The dependency-free base
integration suite does not provide that coverage. Infrastructure fixtures are
located under `docker/integration/`; reusable suite wiring is located under
`support/`.

The Spark suite runs against Spark's built-in catalog without starting
Polaris. The Polaris suite starts Polaris and Spark Connect together. Both
suites accept `--spark-version`; the runner pins each supported Spark image by
digest. For example:

```sh
npm run test:integration:spark -- --spark-version <supported-version>
npm run test:integration:polaris -- --spark-version <supported-version>
```
