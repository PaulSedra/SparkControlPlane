"""CLI for Spark Connect catalog metadata and bounded table samples."""

import argparse
import os
import re
import sys
from typing import Any

from pyspark.sql import SparkSession

from catalog_errors import (
    CatalogConfigurationError,
    CatalogResponseTooLarge,
    safe_diagnostic,
)
from catalog_metadata import (
    describe_table,
    list_catalogs,
    list_schemas,
    list_tables,
)
from catalog_sampling import sample_table
from catalog_serialization import (
    DEFAULT_MAX_RESPONSE_BYTES,
    MAX_CONFIGURED_RESPONSE_BYTES,
    response_size_bytes,
    serialize_json,
)


def main() -> None:
    """Parse one operation, manage its Spark session, and emit one JSON document."""
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("catalogs")

    schemas_parser = subparsers.add_parser("schemas")
    schemas_parser.add_argument("--catalog", required=True)

    tables_parser = subparsers.add_parser("tables")
    tables_parser.add_argument("--catalog", required=True)
    tables_parser.add_argument("--schema", required=True)

    detail_parser = subparsers.add_parser("detail")
    detail_parser.add_argument("--catalog", required=True)
    detail_parser.add_argument("--schema", required=True)
    detail_parser.add_argument("--table", required=True)

    sample_parser = subparsers.add_parser("sample")
    sample_parser.add_argument("--catalog", required=True)
    sample_parser.add_argument("--schema", required=True)
    sample_parser.add_argument("--table", required=True)
    sample_parser.add_argument("--limit", type=int, default=100)

    args = parser.parse_args()
    maximum_response_bytes = configured_max_response_bytes()
    connect_url = os.environ.get("SPARK_CONNECT_URL")
    if not connect_url:
        raise CatalogConfigurationError(
            "SPARK_CONNECT_URL must be configured for catalog discovery."
        )

    spark = SparkSession.builder.remote(connect_url).getOrCreate()
    try:
        payload = dispatch_operation(args, spark, maximum_response_bytes)
    finally:
        spark.stop()

    response = serialize_json(payload)
    if response_size_bytes(response) > maximum_response_bytes:
        raise CatalogResponseTooLarge()
    sys.stdout.write(response + "\n")


def dispatch_operation(
    args: argparse.Namespace,
    spark: SparkSession,
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
    return sample_table(
        spark,
        args.catalog,
        args.schema,
        args.table,
        args.limit,
        maximum_response_bytes,
    )


def run_cli() -> int:
    """Run the CLI while keeping diagnostics credential-free and off stdout."""
    try:
        main()
    except Exception as error:
        diagnostic_code, diagnostic = safe_diagnostic(error)
        sys.stderr.write(
            f"SPARK_CATALOG_ERROR: {diagnostic_code}: {diagnostic}\n"
        )
        return 1
    return 0


def configured_max_response_bytes() -> int:
    """Read a response limit compatible with the Node adapter's hard bound."""
    raw_value = os.environ.get("SPARK_CATALOG_MAX_RESPONSE_BYTES", "").strip()
    if not raw_value:
        return DEFAULT_MAX_RESPONSE_BYTES
    if re.fullmatch(r"[0-9]+", raw_value) is None:
        raise CatalogConfigurationError(
            "SPARK_CATALOG_MAX_RESPONSE_BYTES must be an integer from 1 to "
            f"{MAX_CONFIGURED_RESPONSE_BYTES}."
        )
    try:
        configured_value = int(raw_value, 10)
    except ValueError as error:
        raise CatalogConfigurationError(
            "SPARK_CATALOG_MAX_RESPONSE_BYTES must be an integer from 1 to "
            f"{MAX_CONFIGURED_RESPONSE_BYTES}."
        ) from error
    if not 1 <= configured_value <= MAX_CONFIGURED_RESPONSE_BYTES:
        raise CatalogConfigurationError(
            "SPARK_CATALOG_MAX_RESPONSE_BYTES must be an integer from 1 to "
            f"{MAX_CONFIGURED_RESPONSE_BYTES}."
        )
    return configured_value


if __name__ == "__main__":
    raise SystemExit(run_cli())
