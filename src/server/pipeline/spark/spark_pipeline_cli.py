"""Run PySpark's imported Pipelines CLI with the control-plane spec loader."""

from __future__ import annotations

import sys

from pyspark.pipelines import cli

from spark_pipeline_spec import load_pipeline_spec_for_control_plane


def main() -> None:
    """Install control-plane metadata handling before invoking the CLI module."""
    cli.load_pipeline_spec = load_pipeline_spec_for_control_plane
    sys.argv[0] = "spark-pipelines"
    cli.main()


if __name__ == "__main__":
    main()
