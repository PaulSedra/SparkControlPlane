# Managed integration tests

Repository-owned runners manage disposable dependencies, temporary pipeline
inputs, runtime values, and cleanup for PostgreSQL, Polaris, Spark Standalone,
application-container, and migration-upgrade suites.

Use the npm scripts in the root README to run a suite. The runners own service
startup, dynamic endpoint and credential values, readiness checks, test
selection, and cleanup. The PostgreSQL suite checks persistence, the Polaris
suite checks Polaris catalog integration, and the Spark suite checks the
Spark-backed catalog API and runs a sample pipeline through Standalone
applications. The container suite audits production dependencies and checks
the application runtime; the upgrade suite checks migration behavior.

These managed suites verify external boundaries. The dependency-free base
integration suite does not provide that coverage. Infrastructure fixtures are
located under `docker/integration/`; reusable suite wiring is located under
`support/`.

Both Spark and Polaris suites start the managed Standalone master and worker.
The Spark suite uses the built-in Spark catalog. The Polaris suite uses
Polaris for catalog hierarchy. PR CI runs Polaris with Spark 4.1 and its
matching Iceberg runtime. The separate Spark 4.2 and Polaris workflow tracks
[upstream Iceberg compatibility](https://github.com/apache/iceberg/issues/17959).
Catalog and preview calls, as well as pipeline runs,
submit applications to the same master. Both suites accept `--spark-version`
and `--java-version` (`17`, `21`, or `25`). The runner pins Spark and Java
runtime images by digest and matches the Control Plane PySpark version to Spark. Java 25 with Spark 4.1.3 is included as an exploratory
compatibility combination. For example:

```sh
npm run test:integration:spark -- --spark-version 4.1.3 --java-version 25
npm run test:integration:polaris -- --spark-version 4.1.3 --java-version 17
```
