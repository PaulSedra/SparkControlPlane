"""Run one bounded catalog or preview request inside a spark-submit app."""

import argparse
import base64
import json
import sys
from typing import Any

from pyspark.sql import SparkSession

from catalog_errors import safe_diagnostic
from catalog_metadata import (
    describe_table,
    list_catalogs,
    list_schemas,
    list_tables,
)
from catalog_sampling import (
    MAX_SAMPLE_ROWS,
    SampleResponseBuilder,
    collect_sample_rows,
    sample_table,
)
from catalog_serialization import (
    DEFAULT_MAX_RESPONSE_BYTES,
    MAX_CONFIGURED_RESPONSE_BYTES,
    response_size_bytes,
    serialize_json,
)


def main() -> None:
    """Execute the bounded request in the Spark app launched by spark-submit."""
    parser = argparse.ArgumentParser()
    parser.add_argument("--request-base64", required=True)
    args = parser.parse_args()
    request = json.loads(base64.b64decode(args.request_base64).decode("utf-8"))
    maximum_response_bytes = configured_response_limit(request)
    spark = SparkSession.builder.getOrCreate()
    try:
        payload = dispatch_operation(argparse.Namespace(**request), spark, maximum_response_bytes)
    finally:
        spark.stop()
    response = serialize_json(payload)
    if response_size_bytes(response) > maximum_response_bytes:
        raise RuntimeError("Spark catalog response exceeded its configured byte limit.")
    sys.stdout.write(response + "\n")


def dispatch_operation(
    args: Any,
    spark: Any,
    maximum_response_bytes: int,
) -> Any:
    """Route parsed CLI arguments to one catalog operation."""
    if args.command == "catalogs":
        return {"catalogs": list_catalogs(spark)}
    if args.command == "schemas":
        return {"schemas": list_schemas(spark, args.catalog)}
    if args.command == "tables":
        return {"tables": list_tables(spark, args.catalog, args.schema)}
    if args.command == "detail":
        return describe_table(spark, args.catalog, args.schema, args.table)
    if args.command == "preview":
        return sample_qualified_table(
            spark,
            args.qualifiedName,
            args.limit,
            maximum_response_bytes,
        )
    return sample_table(
        spark,
        args.catalog,
        args.schema,
        args.table,
        args.limit,
        maximum_response_bytes,
    )


def sample_qualified_table(
    spark: SparkSession,
    qualified_name: str,
    limit: int,
    maximum_response_bytes: int,
) -> dict[str, Any]:
    """Return a bounded preview of one fully qualified pipeline output."""
    bounded_limit = max(1, min(limit, MAX_SAMPLE_ROWS))
    frame = spark.table(qualified_name).limit(bounded_limit + 1)
    fields = frame.schema.fields
    columns = [
        {"name": field.name, "type": field.dataType.simpleString()}
        for field in fields
    ]
    response = SampleResponseBuilder(columns, maximum_response_bytes)
    row_limit_truncated, response_size_truncated = collect_sample_rows(
        frame,
        response,
        bounded_limit,
        fields,
    )
    return response.build(
        bounded_limit,
        row_limit_truncated,
        response_size_truncated,
    )


def configured_response_limit(request: dict[str, Any]) -> int:
    """Validate the request's response limit before running Spark work."""
    value = request.get("maximumResponseBytes", DEFAULT_MAX_RESPONSE_BYTES)
    if not isinstance(value, int) or not 1 <= value <= MAX_CONFIGURED_RESPONSE_BYTES:
        raise ValueError(
            f"maximumResponseBytes must be between 1 and {MAX_CONFIGURED_RESPONSE_BYTES}."
        )
    return value


def run_cli() -> int:
    """Keep structured responses on stdout and safe errors on stderr."""
    try:
        main()
    except Exception as error:
        code, message = safe_diagnostic(error)
        sys.stderr.write(f"SPARK_CATALOG_ERROR: {code}: {message}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(run_cli())
