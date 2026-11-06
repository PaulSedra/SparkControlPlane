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

_SQL_WORD = "word"
_SQL_IDENTIFIER = "identifier"
_SQL_STRING = "string"
_SQL_PUNCTUATION = "punctuation"
_SQL_OTHER = "other"
_SQL_SOURCE_KEYWORDS = frozenset({"FROM", "JOIN"})


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
        for table_name in sql_stream_table_names(call, function_globals):
            if table_name not in inputs:
                inputs.append(table_name)
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


def sql_stream_table_names(
    call: ast.Call,
    function_globals: dict[str, Any],
) -> list[str]:
    """Return STREAM table references from a literal Spark SQL query."""
    if not isinstance(call.func, ast.Attribute) or call.func.attr != "sql":
        return []
    query = literal_sql_query(call, function_globals)
    if query is None:
        return []
    return _sql_stream_table_names(_tokenize_sql(query))


def _sql_stream_table_names(tokens: list[tuple[str, str]]) -> list[str]:
    """Find and deduplicate table references in FROM/JOIN STREAM clauses."""
    table_names: list[str] = []
    seen_table_names: set[str] = set()
    token_index = 0
    while token_index < len(tokens):
        if not _is_sql_stream_clause(tokens, token_index):
            token_index += 1
            continue
        table_name, next_token_index = _sql_stream_table_reference(tokens, token_index)
        if table_name is not None and table_name not in seen_table_names:
            table_names.append(table_name)
            seen_table_names.add(table_name)
        token_index = max(token_index + 1, next_token_index)
    return table_names


def _is_sql_stream_clause(tokens: list[tuple[str, str]], start: int) -> bool:
    """Check whether a token position starts FROM/JOIN STREAM."""
    return (
        start + 1 < len(tokens)
        and tokens[start][0] == _SQL_WORD
        and tokens[start][1].upper() in _SQL_SOURCE_KEYWORDS
        and tokens[start + 1][0] == _SQL_WORD
        and tokens[start + 1][1].upper() == "STREAM"
    )


def _sql_stream_table_reference(
    tokens: list[tuple[str, str]],
    clause_index: int,
) -> tuple[str | None, int]:
    """Read a STREAM table reference and return the next token position."""
    identifier_index = clause_index + 2
    parenthesized = _has_sql_token(
        tokens,
        identifier_index,
        _SQL_PUNCTUATION,
        "(",
    )
    if parenthesized:
        identifier_index += 1
    table_name, next_token_index = _multipart_sql_identifier(
        tokens,
        identifier_index,
    )
    if not parenthesized:
        return table_name, next_token_index
    if table_name is None or not _has_sql_token(
        tokens,
        next_token_index,
        _SQL_PUNCTUATION,
        ")",
    ):
        return None, max(clause_index + 1, next_token_index)
    return table_name, next_token_index + 1


def _has_sql_token(
    tokens: list[tuple[str, str]],
    index: int,
    token_type: str,
    token_value: str,
) -> bool:
    """Check a token's type and value without indexing past the token list."""
    return index < len(tokens) and tokens[index] == (token_type, token_value)


def _tokenize_sql(query: str) -> list[tuple[str, str]]:
    """Split SQL into code tokens while consuming literals and comments linearly."""
    tokens: list[tuple[str, str]] = []
    position = 0
    while position < len(query):
        token, position = _next_sql_token(query, position)
        if token is not None:
            tokens.append(token)
    return tokens


def _next_sql_token(
    query: str,
    position: int,
) -> tuple[tuple[str, str] | None, int]:
    """Read one code token or skip one whitespace/comment section."""
    character = query[position]
    if character.isspace():
        return None, position + 1
    comment_end = _skip_sql_comment(query, position)
    if comment_end is not None:
        return None, comment_end
    if character in ("'", '"'):
        next_position = _skip_sql_quoted_text(query, position, character)
        return (_SQL_STRING, ""), next_position
    if character == "`":
        return _read_sql_quoted_identifier_token(query, position)
    if _is_sql_identifier_start(character):
        return _read_sql_word_token(query, position)
    return (_SQL_PUNCTUATION, character), position + 1


def _skip_sql_comment(query: str, start: int) -> int | None:
    """Skip one SQL line or block comment, if one starts at this position."""
    if query.startswith("--", start):
        return _skip_sql_line_comment(query, start)
    if query.startswith("/*", start):
        return _skip_sql_block_comment(query, start)
    return None


def _skip_sql_line_comment(query: str, start: int) -> int:
    """Skip through the end of a SQL line comment."""
    position = start + 2
    while position < len(query) and query[position] not in "\r\n":
        position += 1
    return position


def _read_sql_quoted_identifier_token(
    query: str,
    start: int,
) -> tuple[tuple[str, str], int]:
    """Return a token for one backtick identifier, including malformed input."""
    identifier, next_position = _read_sql_quoted_identifier(query, start)
    if identifier is None:
        return (_SQL_OTHER, ""), next_position
    return (_SQL_IDENTIFIER, identifier), next_position


def _read_sql_word_token(
    query: str,
    start: int,
) -> tuple[tuple[str, str], int]:
    """Read one supported bare SQL identifier token."""
    position = start + 1
    while position < len(query) and _is_sql_identifier_part(query[position]):
        position += 1
    return (_SQL_WORD, query[start:position]), position


def _skip_sql_block_comment(query: str, start: int) -> int:
    """Skip a possibly nested block comment without revisiting its contents."""
    depth = 1
    position = start + 2
    while position < len(query) and depth > 0:
        if query.startswith("/*", position):
            depth += 1
            position += 2
        elif query.startswith("*/", position):
            depth -= 1
            position += 2
        else:
            position += 1
    return position


def _skip_sql_quoted_text(query: str, start: int, quote: str) -> int:
    """Skip a SQL string, honoring doubled quotes and backslash escapes."""
    position = start + 1
    while position < len(query):
        if query[position] == "\\" and position + 1 < len(query):
            position += 2
        elif query[position] == quote:
            if position + 1 < len(query) and query[position + 1] == quote:
                position += 2
            else:
                return position + 1
        else:
            position += 1
    return position


def _read_sql_quoted_identifier(query: str, start: int) -> tuple[str | None, int]:
    """Read a backtick identifier and unescape doubled backticks."""
    position = start + 1
    while position < len(query):
        if query[position] == "`":
            if position + 1 < len(query) and query[position + 1] == "`":
                position += 2
            else:
                value = query[start + 1:position].replace("``", "`")
                return (value or None), position + 1
        else:
            position += 1
    return None, position


def _multipart_sql_identifier(
    tokens: list[tuple[str, str]],
    start: int,
) -> tuple[str | None, int]:
    """Read a dotted sequence of bare or backtick-quoted SQL identifiers."""
    if start >= len(tokens) or tokens[start][0] not in (_SQL_WORD, _SQL_IDENTIFIER):
        return None, start
    parts = [tokens[start][1]]
    position = start + 1
    while (
        position + 1 < len(tokens)
        and tokens[position] == (_SQL_PUNCTUATION, ".")
        and tokens[position + 1][0] in (_SQL_WORD, _SQL_IDENTIFIER)
    ):
        parts.append(tokens[position + 1][1])
        position += 2
    return ".".join(parts), position


def _is_sql_identifier_start(character: str) -> bool:
    """Return whether a character can begin the supported bare identifier form."""
    return "A" <= character <= "Z" or "a" <= character <= "z" or character == "_"


def _is_sql_identifier_part(character: str) -> bool:
    """Return whether a character can continue the supported bare identifier form."""
    return (
        _is_sql_identifier_start(character)
        or "0" <= character <= "9"
        or character == "$"
    )


def literal_sql_query(call: ast.Call, function_globals: dict[str, Any]) -> str | None:
    """Resolve literal SQL text or an uppercase module string constant."""
    argument = call.args[0] if call.args else next(
        (keyword.value for keyword in call.keywords if keyword.arg == "sqlQuery"),
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
