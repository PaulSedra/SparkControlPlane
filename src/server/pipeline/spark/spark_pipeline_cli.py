"""Run PySpark's imported Pipelines CLI with the control-plane spec loader."""

from __future__ import annotations

import os
from pathlib import Path
import sys

from pyspark import __version__ as spark_version
from pyspark.pipelines import cli

from spark_pipeline_spec import load_pipeline_spec_for_control_plane


def main() -> None:
    """Install control-plane metadata handling before invoking the CLI module."""
    if "--spec" in sys.argv:
        spec_path = Path(sys.argv[sys.argv.index("--spec") + 1]).resolve()
        project_root = (
            spec_path.parent.parent
            if spec_path.parent.name.lower() == "resources"
            else spec_path.parent
        )
        sys.path.insert(0, str(project_root))
    if spark_version.startswith("4.1.") and sys.argv[1:2] == ["--remote"]:
        # Spark 4.1 chooses its Connect server through SparkSession's environment.
        os.environ["SPARK_REMOTE"] = sys.argv[2]
        del sys.argv[1:3]
    cli.load_pipeline_spec = load_pipeline_spec_for_control_plane
    sys.argv[0] = "spark-pipelines"
    cli.main()


if __name__ == "__main__":
    main()
