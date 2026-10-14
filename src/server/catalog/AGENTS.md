# Catalog change instructions

Read the [catalog adapter architecture](README.md) and
[`../README.md`](../README.md) before changing this module.

- Preserve the CLI boundary, helper ownership, and JSON stdout/stderr contract
  described in the README.
- Validate qualified catalog and schema values, quote identifiers before Spark
  SQL use, and retain row, byte, and time bounds.
- Keep catalog and monitoring requests on their existing service paths.
- Preserve the documented distinction between unsupported metadata and
  permission, connection, or unexpected failures.
- Keep credential filtering and embedded URI redaction in metadata responses.
