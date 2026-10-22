"""Create the deterministic Iceberg table used by live catalog acceptance."""

from __future__ import annotations

import os

from pyspark.sql import SparkSession


def main() -> None:
    """Create one namespace and a bounded table through Spark Connect."""
    catalog = os.environ.get("INTEGRATION_CATALOG_NAME", "integration_catalog")
    namespace = os.environ.get("INTEGRATION_NAMESPACE", "integration")
    table = os.environ.get("INTEGRATION_TABLE_NAME", "seed_events")
    provider = os.environ.get("INTEGRATION_TABLE_PROVIDER", "iceberg")
    remote = os.environ.get("SPARK_CONNECT_URL", "sc://spark-connect:15002")

    if provider not in {"iceberg", "parquet"}:
        raise ValueError("INTEGRATION_TABLE_PROVIDER must be iceberg or parquet.")

    spark = SparkSession.builder.remote(remote).getOrCreate()
    try:
        spark.sql(f"CREATE NAMESPACE IF NOT EXISTS {catalog}.{namespace}")
        spark.sql(
            f"CREATE TABLE IF NOT EXISTS {catalog}.{namespace}.{table} "
            f"(id INT, label STRING) USING {provider}"
        )
        spark.sql(
            f"INSERT INTO {catalog}.{namespace}.{table} VALUES "
            "(1, 'one'), (2, 'two'), (3, 'three')"
        )
        count = spark.sql(
            f"SELECT COUNT(*) AS count FROM {catalog}.{namespace}.{table}"
        ).collect()[0]["count"]
        if count < 3:
            raise RuntimeError("The integration seed table did not contain three rows.")
        print(f"SEEDED {catalog}.{namespace}.{table} rows={count}")
    finally:
        spark.stop()


if __name__ == "__main__":
    main()
