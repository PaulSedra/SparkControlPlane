from pyspark import pipelines as dp
from pyspark.sql import functions as F


@dp.materialized_view
def demo_python_events():
    return (
        spark.range(1, 4)
        .select(
            F.col("id").cast("int").alias("event_id"),
            F.when(F.col("id") == 2, F.lit("closed"))
            .otherwise(F.lit("opened"))
            .alias("event_type"),
            (F.col("id").cast("double") / 2 + F.lit(0.5)).alias(
                "event_weight"
            ),
        )
    )
