"""Fetch a bounded data sample from a Spark pipeline dataset."""

import argparse
import datetime
import decimal
import json
import os

from pyspark.sql import SparkSession


def main() -> None:
    """Query a bounded Spark Connect sample and emit a JSON schema/row payload.

    The command clamps the caller's limit to 1..100 so a UI preview cannot
    become an unbounded table scan; identifier quoting keeps dotted names and
    embedded backticks inside the intended SQL identifier.
    """
    parser = argparse.ArgumentParser()
    parser.add_argument("qualified_name")
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()

    connect_url = os.environ.get("SPARK_CONNECT_URL")
    if not connect_url:
        raise RuntimeError("SPARK_CONNECT_URL is not configured for data samples.")

    limit = max(1, min(args.limit, 100))
    spark = SparkSession.builder.remote(connect_url).getOrCreate()
    frame = spark.sql(
        f"SELECT * FROM {quoted_identifier(args.qualified_name)} LIMIT {limit}"
    )
    payload = {
        "columns": [
            {"name": field.name, "type": field.dataType.simpleString()}
            for field in frame.schema.fields
        ],
        "rows": [list(row) for row in frame.collect()],
    }
    print(json.dumps(payload, default=json_value))


def quoted_identifier(qualified_name: str) -> str:
    """Quote each multipart identifier segment and escape embedded backticks."""
    return ".".join(
        f"`{part.replace('`', '``')}`" for part in qualified_name.split(".")
    )


def json_value(value: object) -> str:
    """Serialize date-like and decimal values for JSON output."""
    if isinstance(value, (datetime.date, datetime.datetime, decimal.Decimal)):
        return str(value)
    return str(value)


if __name__ == "__main__":
    main()
