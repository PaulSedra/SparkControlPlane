#!/usr/bin/env bash
set -euo pipefail

arguments=(
    --wait
    --conf spark.sql.warehouse.dir=file:///tmp/spark-control-plane-integration-warehouse
    --conf spark.jars.ivy=/tmp/.ivy2.5.2
    --conf spark.driver.bindAddress=0.0.0.0
    --conf spark.driver.host=spark-connect
)

case "${CATALOG_BACKEND:?The integration catalog backend is required}" in
    polaris)
        catalog="${POLARIS_CATALOG_NAME:?The integration Polaris catalog name is required}"
        arguments+=(
            --packages org.apache.iceberg:iceberg-spark-runtime-4.1_2.13:1.11.0
            --conf spark.sql.extensions=org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions
            --conf "spark.sql.catalog.${catalog}=org.apache.iceberg.spark.SparkCatalog"
            --conf "spark.sql.catalog.${catalog}.type=rest"
            --conf "spark.sql.catalog.${catalog}.warehouse=${catalog}"
            --conf "spark.sql.catalog.${catalog}.uri=http://polaris:8181/api/catalog"
            --conf "spark.sql.catalog.${catalog}.credential=${POLARIS_CLIENT_ID:?The integration Polaris client ID is required}:${POLARIS_CLIENT_SECRET:?The integration Polaris client secret is required}"
            --conf "spark.sql.catalog.${catalog}.scope=PRINCIPAL_ROLE:ALL"
            --conf "spark.sql.catalog.${catalog}.header.X-Iceberg-Access-Delegation=vended-credentials"
            --conf "spark.sql.defaultCatalog=${catalog}"
        )
        ;;
    spark)
        arguments+=(
            --conf spark.sql.catalogImplementation=in-memory
            --conf spark.sql.defaultCatalog=spark_catalog
        )
        ;;
    *)
        printf 'Unsupported integration catalog backend: %s\n' "$CATALOG_BACKEND" >&2
        exit 2
        ;;
esac

exec /opt/spark/sbin/start-connect-server.sh "${arguments[@]}"
