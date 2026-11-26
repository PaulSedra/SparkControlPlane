"""Load PySpark specs after removing control-plane-owned metadata."""

from __future__ import annotations

from pathlib import Path

import yaml
from pyspark.pipelines.cli import PipelineSpec, unpack_pipeline_spec


def load_pipeline_spec_for_control_plane(spec_path: Path) -> PipelineSpec:
    """Strip SCP-only fields before handing the definition to Spark's SDP runtime."""
    with spec_path.open("r", encoding="utf-8") as source:
        spec_data = yaml.safe_load(source)
    if isinstance(spec_data, dict):
        spec_data = {
            key: value for key, value in spec_data.items()
            if key not in {"on_success", "timeout_seconds", "triggers"}
        }
    return unpack_pipeline_spec(spec_data)
