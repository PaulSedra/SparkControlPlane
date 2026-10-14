"""Discover Python pipeline graph elements using PySpark's registry API."""

from __future__ import annotations

import argparse
import ast
import importlib.util
import inspect
import json
import os
import sys
import textwrap
from pathlib import Path
from typing import Any

from pyspark.pipelines.flow import AutoCdcFlow, Flow
from pyspark.pipelines.graph_element_registry import (
    GraphElementRegistry,
    graph_element_registration_context,
)
from pyspark.pipelines.output import (
    MaterializedView,
    Output,
    Sink,
    StreamingTable,
    TemporaryView,
)
from spark_pipeline_spec import load_pipeline_spec_for_control_plane


def main() -> None:
    """Run discovery for one spec and emit the JSON manifest consumed by Node."""
    parser = argparse.ArgumentParser()
    parser.add_argument("spec_path", type=Path)
    args = parser.parse_args()
    print(json.dumps(discover(args.spec_path)))


def discover(spec_path: Path) -> dict[str, list[dict[str, Any]]]:
    """Import configured Python libraries and return their registered graph elements.

    Discovery temporarily changes cwd because relative library imports are
    project-relative. It restores the caller's cwd in `finally`, skips cache
    and non-Python matches, and records definitions rather than starting a
    Spark execution.
    """
    spec = load_pipeline_spec_for_control_plane(spec_path)
    root = spec_path.parent.resolve()
    registry = RecordingGraphElementRegistry()
    previous_directory = Path.cwd()
    add_pipeline_import_paths(root)

    try:
        os.chdir(root)
        with graph_element_registration_context(registry):
            for library in spec.libraries:
                for source_file in sorted(root.glob(library.include)):
                    if (
                        not source_file.is_file()
                        or source_file.suffix.lower() != ".py"
                        or "__pycache__" in source_file.parts
                    ):
                        continue
                    module_spec = importlib.util.spec_from_file_location(
                        source_file.stem,
                        source_file,
                    )
                    if module_spec is None or module_spec.loader is None:
                        raise RuntimeError(f"Could not load pipeline source: {source_file}")
                    module = importlib.util.module_from_spec(module_spec)
                    module_spec.loader.exec_module(module)
    finally:
        os.chdir(previous_directory)

    return {"flows": registry.flows, "outputs": registry.outputs}


class RecordingGraphElementRegistry(GraphElementRegistry):
    """Capture Python-registered graph elements without executing a pipeline run.

    Spark invokes this registry while importing pipeline libraries; the
    control plane uses the captured names and source locations for discovery,
    while SQL registrations are intentionally handled by the separate SQL
    parser.
    """

    def __init__(self) -> None:
        """Initialize empty output and flow capture lists."""
        self.flows: list[dict[str, Any]] = []
        self.outputs: list[dict[str, Any]] = []

    def register_output(self, output: Output) -> None:
        """Record an output's stable name, source location, and UI node type."""
        self.outputs.append(
            {
                "name": output.name,
                "sourceFile": output.source_code_location.filename,
                "sourceLine": output.source_code_location.line_number,
                "type": output_type(output),
            }
        )

    def register_flow(self, flow: Flow) -> None:
        """Record a flow target and source location for lineage discovery."""
        self.flows.append(
            {
                "name": flow.name,
                "sourceFile": flow.source_code_location.filename,
                "sourceLine": flow.source_code_location.line_number,
                "target": flow.target,
                "inputs": flow_input_table_names(flow),
            }
        )

    def register_auto_cdc_flow(self, flow: AutoCdcFlow) -> None:
        """Record an Auto CDC flow using its declared source and target."""
        self.flows.append(
            {
                "name": flow.name or flow.target,
                "sourceFile": flow.source_code_location.filename,
                "sourceLine": flow.source_code_location.line_number,
                "target": flow.target,
                "inputs": [flow.source],
                "inputEvidence": "SPARK_GRAPH_REGISTRATION",
            }
        )

    def register_sql(self, sql_text: str, file_path: Path) -> None:
        """Ignore SQL registrations because SQL lineage is parsed separately."""
        del sql_text, file_path


def flow_input_table_names(flow: Flow) -> list[str]:
    """Return literal Spark table reads from a flow and its module helpers.

    The function is inspected without execution because invoking it would build
    a Spark DataFrame and require a live Spark session. Direct calls to module
    functions are followed once per function, including recursive helpers.
    Imported functions, methods, and computed table names remain undiscovered.
    """
    function_globals = getattr(flow.func, "__globals__", {})
    pending_functions = [flow.func]
    visited_functions = {flow.func}
    inputs: list[str] = []
    while pending_functions:
        inspect_flow_function(
            pending_functions.pop(),
            function_globals,
            pending_functions,
            visited_functions,
            inputs,
        )
    return inputs


def inspect_flow_function(
    function: Any,
    function_globals: dict[str, Any],
    pending_functions: list[Any],
    visited_functions: set[Any],
    inputs: list[str],
) -> None:
    """Collect one function's literal reads and enqueue local helpers."""
    calls = function_calls(function)
    if calls is None:
        return
    for call in calls:
        if is_spark_table_read(call):
            table_name = literal_table_name(call, function_globals)
            if table_name is not None and table_name not in inputs:
                inputs.append(table_name)
            continue
        helper = module_helper_function(call, function_globals, visited_functions)
        if helper is not None:
            visited_functions.add(helper)
            pending_functions.append(helper)


def function_calls(function: Any) -> list[ast.Call] | None:
    """Parse a helper function and return its calls in source order."""
    try:
        source = inspect.getsource(function)
        function_tree = ast.parse(textwrap.dedent(source))
    except (OSError, SyntaxError, TypeError):
        return None
    return sorted(
        (node for node in ast.walk(function_tree) if isinstance(node, ast.Call)),
        key=lambda node: (node.lineno, node.col_offset),
    )


def module_helper_function(
    call: ast.Call,
    function_globals: dict[str, Any],
    visited_functions: set[Any],
) -> Any | None:
    """Return a not-yet-visited function defined in the flow's module."""
    if not isinstance(call.func, ast.Name):
        return None
    helper = function_globals.get(call.func.id)
    if (
        inspect.isfunction(helper)
        and helper.__globals__ is function_globals
        and helper not in visited_functions
    ):
        return helper
    return None


def is_spark_table_read(call: ast.Call) -> bool:
    """Check for `.read[Stream][...].table()` calls, including reader options."""
    return (
        isinstance(call.func, ast.Attribute)
        and call.func.attr == "table"
        and bool({"read", "readStream"} & expression_attribute_names(call.func.value))
    )


def expression_attribute_names(expression: ast.expr) -> set[str]:
    """Collect names in an attribute chain, including chained reader calls."""
    if isinstance(expression, ast.Name):
        return {expression.id}
    if isinstance(expression, ast.Attribute):
        return expression_attribute_names(expression.value) | {expression.attr}
    if isinstance(expression, ast.Call):
        return expression_attribute_names(expression.func)
    return set()


def literal_table_name(call: ast.Call, function_globals: dict[str, Any]) -> str | None:
    """Resolve a literal or uppercase module string passed to a Spark read call."""
    argument = call.args[0] if call.args else next(
        (keyword.value for keyword in call.keywords if keyword.arg == "tableName"),
        None,
    )
    if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
        return argument.value
    if isinstance(argument, ast.Name) and argument.id.isupper():
        value = function_globals.get(argument.id)
        if isinstance(value, str):
            return value
    return None

def output_type(output: Output) -> str:
    """Map Spark output classes to the graph node types exposed by the UI.

    The fallback preserves the historical streaming-table contract for an
    unknown output subclass instead of dropping a discovered node.
    """
    if isinstance(output, MaterializedView):
        return "MATERIALIZED_VIEW"
    if isinstance(output, StreamingTable):
        return "STREAMING_TABLE"
    if isinstance(output, TemporaryView):
        return "TEMPORARY_VIEW"
    if isinstance(output, Sink):
        return "SINK"
    return "STREAMING_TABLE"


def add_pipeline_import_paths(root: Path) -> None:
    """Add the mounted project/package roots needed by discovered imports.

    The roots are inserted only when absent and in reverse collection order so
    the project-local path wins without repeatedly mutating `sys.path` across
    discovery calls.
    """
    import_roots = [root]
    configured_root = os.environ.get("PIPELINES_DIR")
    if configured_root:
        import_roots.append(Path(configured_root).expanduser().resolve().parent)
    else:
        for parent in (root, *root.parents):
            if parent.name.lower() == "pipelines":
                import_roots.append(parent.parent)
                break

    for import_root in reversed(import_roots):
        import_path = str(import_root)
        if import_path not in sys.path:
            sys.path.insert(0, import_path)


if __name__ == "__main__":
    main()
