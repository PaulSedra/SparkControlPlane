from pyspark import pipelines as dp


@dp.materialized_view
def intentional_demo_failure():
    """Raise during every run to demonstrate a failed pipeline."""
    raise RuntimeError("Intentional failure from the demo pipeline.")
