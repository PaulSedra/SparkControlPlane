"""Catalog discovery, Spark metadata parsing, and object classification."""

import re
from collections.abc import Iterable
from typing import Any

from pyspark.sql import Row, SparkSession

from catalog_errors import is_unsupported_spark_operation, write_warning
from catalog_serialization import (
    SENSITIVE_PROPERTY_PATTERN,
    redact_metadata_value,
)

PROPERTY_KEY_PATTERN = re.compile(r"[A-Za-z0-9_./:-]+\Z")


def list_catalogs(spark: SparkSession) -> list[dict[str, str]]:
    """Return catalog names using Spark's catalog command."""
    rows = spark.sql("SHOW CATALOGS").toLocalIterator()
    return [
        {"name": string_value(row, "catalog", "catalogName", "namespace")}
        for row in rows
    ]


def list_schemas(spark: SparkSession, catalog: str) -> list[dict[str, str]]:
    """Return schema names in one quoted catalog namespace."""
    rows = spark.sql(f"SHOW SCHEMAS IN {quote_identifier(catalog)}").toLocalIterator()
    return [
        {
            "catalog": catalog,
            "name": string_value(row, "namespace", "databaseName", "schemaName"),
        }
        for row in rows
    ]


def list_tables(spark: SparkSession, catalog: str, schema: str) -> list[dict[str, Any]]:
    """Return tables/views and enrich their type from one metadata query when available."""
    namespace = qualified_identifier(catalog, schema)
    table_rows = spark.sql(f"SHOW TABLES IN {namespace}").toLocalIterator()
    tables: list[dict[str, Any]] = []
    for row in table_rows:
        name = string_value(row, "tableName", "table_name", "name")
        tables.append(
            {
                "catalog": catalog,
                "isTemporary": boolean_value(row, "isTemporary", "is_temporary"),
                "name": name,
                "schema": schema,
                "tableType": "UNKNOWN",
            }
        )

    type_by_name = table_types(spark, namespace)
    for table in tables:
        table["tableType"] = type_by_name.get(table["name"], "UNKNOWN")
    return tables


def table_types(spark: SparkSession, namespace: str) -> dict[str, str]:
    """Classify namespace objects through SHOW TABLE EXTENDED when supported.

    Older or restricted Spark catalogs may reject that command; returning an
    empty mapping preserves table discovery while reporting UNKNOWN object
    types rather than failing the whole catalog request.
    """
    result: dict[str, str] = {}
    try:
        rows = spark.sql(
            f"SHOW TABLE EXTENDED IN {namespace} LIKE '*'"
        ).toLocalIterator()
        for row in rows:
            name = string_value(row, "tableName", "table_name", "name")
            information = string_value(row, "information")
            match = re.search(r"(?:^|\n)Type:\s*([^\n]+)", information, re.IGNORECASE)
            if name:
                result[name] = classify_table_type(
                    {"Type": match.group(1).strip() if match else ""}
                )
    except Exception as error:
        if not is_unsupported_spark_operation(error):
            raise
        write_warning(
            "SHOW TABLE EXTENDED is unsupported; listed object types will be UNKNOWN."
        )
        return {}
    return result


def describe_table(
    spark: SparkSession,
    catalog: str,
    schema: str,
    table: str,
) -> dict[str, Any]:
    """Parse Spark DESCRIBE TABLE EXTENDED into the JSON catalog contract.

    Schema columns are de-duplicated across the ordinary and partition sections;
    partition names and detailed metadata remain separate. If Spark omits the
    detailed metadata marker, properties are discarded instead of being inferred
    from unrelated rows.
    """
    qualified_name = qualified_identifier(catalog, schema, table)
    try:
        columns, partition_columns, properties, table_information_started = (
            parse_describe_rows(
                spark.sql(
                    f"DESCRIBE TABLE EXTENDED {qualified_name}"
                ).toLocalIterator()
            )
        )
    except Exception as error:
        if not is_unsupported_spark_operation(error):
            raise
        write_warning(
            "DESCRIBE TABLE EXTENDED is unsupported; using basic column metadata."
        )
        columns, partition_columns, properties, table_information_started = (
            parse_describe_rows(
                spark.sql(f"DESCRIBE TABLE {qualified_name}").toLocalIterator()
            )
        )

    if not table_information_started:
        properties = {}

    partition_columns = unique_strings(
        partition_columns
        + parse_partition_columns(properties.get("Partition Columns", ""))
    )
    table_type = classify_table_type(properties)
    safe_properties = safe_metadata_properties(properties)
    comment = redact_metadata_value(properties.get("Comment", "")) or None
    view_definition = None
    if table_type == "VIEW":
        view_definition = redact_metadata_value(
            properties.get("View Original Text")
            or properties.get("View Text")
            or ""
        ) or None
    return {
        "catalog": catalog,
        "comment": comment,
        "columns": columns,
        "isTemporary": False,
        "location": redact_metadata_value(properties.get("Location", "")) or None,
        "name": table,
        "partitionColumns": partition_columns,
        "properties": safe_properties,
        "provider": properties.get("Provider") or None,
        "schema": schema,
        "tableType": table_type,
        "viewDefinition": view_definition,
    }


def parse_describe_rows(
    rows: Iterable[Row],
) -> tuple[list[dict[str, str]], list[str], dict[str, str], bool]:
    """Return unique columns, partition names, detailed properties, and marker state."""
    columns: list[dict[str, str]] = []
    partition_columns: list[str] = []
    properties: dict[str, str] = {}
    section = "columns"
    metadata_started = False
    table_information_started = False

    for row in rows:
        first, second, third = describe_row_parts(row)
        marker = first.casefold()
        if marker == "# partition information":
            section = "partitions"
            continue
        if marker == "# detailed table information":
            metadata_started = True
            table_information_started = True
            section = "metadata"
            continue
        if first.startswith("#"):
            continue
        if section == "metadata" or metadata_started:
            apply_describe_metadata(properties, first, second)
        elif section == "partitions":
            if first:
                partition_columns.append(first)
            append_describe_column(columns, first, second, third)
        else:
            append_describe_column(columns, first, second, third)

    return (
        columns,
        unique_strings(partition_columns),
        properties,
        table_information_started,
    )


def describe_row_parts(row: Row) -> tuple[str, str, str]:
    """Return the first three trimmed DESCRIBE TABLE values."""
    values = row_values(row)
    return (
        values[0].strip() if values else "",
        values[1].strip() if len(values) > 1 else "",
        values[2].strip() if len(values) > 2 else "",
    )


def append_describe_column(
    columns: list[dict[str, str]],
    name: str,
    data_type: str,
    comment: str,
) -> None:
    """Append one non-empty column description."""
    if not name or not data_type:
        return
    if any(column["name"] == name for column in columns):
        return
    column = {"name": name, "type": data_type}
    if comment:
        column["comment"] = comment
    columns.append(column)


def apply_describe_metadata(
    properties: dict[str, str],
    name: str,
    value: str,
) -> None:
    """Merge one detailed metadata row into the table properties."""
    if not name or not value:
        return
    if name.casefold() == "table properties":
        for key, property_value in parse_table_properties(value).items():
            properties.setdefault(key, property_value)
        return
    properties[name] = value


def parse_table_properties(value: str) -> dict[str, str]:
    """Expand Spark's map display while respecting quotes and nested values."""
    text = value.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    properties: dict[str, str] = {}
    for entry in split_property_entries(text):
        equals_index = find_top_level_character(entry, "=")
        if equals_index <= 0:
            continue
        key = entry[:equals_index].strip()
        if key:
            properties[key] = entry[equals_index + 1:].strip()
    return properties


def split_property_entries(text: str) -> list[str]:
    """Split map entries on top-level commas that begin a property key."""
    entries: list[str] = []
    entry_start = 0
    stack: list[str] = []
    quote: str | None = None
    escaped = False
    matching_delimiter = {"]": "[", "}": "{", ")": "(",
    }

    for index, character in enumerate(text):
        quote, escaped = advance_property_parser(
            character,
            stack,
            quote,
            escaped,
            matching_delimiter,
        )
        if character == "," and quote is None and not escaped and not stack:
            if starts_property_entry(text, index + 1):
                entries.append(text[entry_start:index].strip())
                entry_start = index + 1

    entries.append(text[entry_start:].strip())
    return [entry for entry in entries if entry]


def starts_property_entry(text: str, start: int) -> bool:
    """Return whether text after a comma begins a syntactically simple key."""
    candidate = text[start:].lstrip()
    equals_index = find_top_level_character(candidate, "=")
    if equals_index <= 0:
        return False
    return PROPERTY_KEY_PATTERN.fullmatch(candidate[:equals_index].strip()) is not None


def find_top_level_character(text: str, target: str) -> int:
    """Find a delimiter outside quoted and nested values."""
    stack: list[str] = []
    quote: str | None = None
    escaped = False
    matching_delimiter = {"]": "[", "}": "{", ")": "(",
    }

    for index, character in enumerate(text):
        quote, escaped = advance_property_parser(
            character,
            stack,
            quote,
            escaped,
            matching_delimiter,
        )
        if character == target and quote is None and not escaped and not stack:
            return index
    return -1


def advance_property_parser(
    character: str,
    stack: list[str],
    quote: str | None,
    escaped: bool,
    matching_delimiter: dict[str, str],
) -> tuple[str | None, bool]:
    """Update quote and delimiter state for one property-map character."""
    if quote is not None:
        if escaped:
            return quote, False
        if character == chr(92):
            return quote, True
        if character == quote:
            return None, False
        return quote, False
    if character in {"'", '"'}:
        return character, False
    if character in "[{(":
        stack.append(character)
    elif character in "]})" and stack and stack[-1] == matching_delimiter[character]:
        stack.pop()
    return None, False


def parse_partition_columns(value: str) -> list[str]:
    """Read the bracketed partition-column list from Spark metadata."""
    text = value.strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    return [
        item.strip().strip(chr(96))
        for item in text.split(",")
        if item.strip()
    ]


def unique_strings(values: list[str]) -> list[str]:
    """Preserve first-seen order while removing duplicate names."""
    unique: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value and value not in seen:
            unique.append(value)
            seen.add(value)
    return unique


def classify_table_type(properties: dict[str, str]) -> str:
    """Return a known Spark object type only when metadata supports it."""
    raw_type = properties.get("Type", "").strip().casefold()
    if raw_type in {"view", "temporary view", "materialized view"}:
        return "VIEW"
    if any(
        properties.get(key, "").strip()
        for key in ("View Original Text", "View Text")
    ):
        return "VIEW"
    if raw_type in {
        "base table",
        "external",
        "external table",
        "managed",
        "managed table",
        "table",
    }:
        return "TABLE"
    return "UNKNOWN"


def safe_metadata_properties(properties: dict[str, str]) -> dict[str, str]:
    """Remove credential-bearing property keys and redact embedded secrets."""
    return {
        key: redact_metadata_value(value)
        for key, value in properties.items()
        if not SENSITIVE_PROPERTY_PATTERN.search(key)
    }


def qualified_identifier(*parts: str) -> str:
    """Quote each multipart identifier for Spark SQL."""
    return ".".join(quote_identifier(part) for part in parts)


def quote_identifier(value: str) -> str:
    """Quote one Spark SQL identifier and escape embedded backticks."""
    delimiter = chr(96)
    escaped = value.replace(delimiter, delimiter + delimiter)
    return delimiter + escaped + delimiter


def row_values(row: Row) -> list[str]:
    """Convert a Spark row to displayable string values."""
    return ["" if value is None else str(value) for value in row]


def row_dict(row: Row) -> dict[str, Any]:
    """Convert a Spark row to a recursively materialized mapping."""
    return row.asDict(recursive=True)


def string_value(row: Row, *names: str) -> str:
    """Read the first available field alias from a Spark row."""
    values = row_dict(row)
    for name in names:
        value = values.get(name)
        if value is not None:
            return str(value)
    return ""


def boolean_value(row: Row, *names: str) -> bool:
    """Interpret common Spark boolean representations."""
    value = string_value(row, *names).lower()
    return value in {"true", "1", "yes"}
