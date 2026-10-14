"""Streaming, byte-bounded sampling of Spark catalog tables."""

from collections.abc import Mapping
from typing import Any

from pyspark.sql import SparkSession

from catalog_errors import CatalogResponseTooLarge
from catalog_metadata import qualified_identifier
from catalog_serialization import (
    DEFAULT_MAX_RESPONSE_BYTES,
    response_size_bytes,
    serialize_json,
    serialize_spark_value,
)

MAX_SAMPLE_ROWS = 100


class SampleResponseBuilder:
    """Track encoded rows once and fit final truncation metadata under the cap."""

    def __init__(
        self,
        columns: list[dict[str, str]],
        maximum_response_bytes: int,
    ) -> None:
        self.columns = columns
        self.maximum_response_bytes = maximum_response_bytes
        self.rows: list[list[Any]] = []
        self._serialized_row_sizes: list[int] = []
        self._row_content_size_bytes = 0
        self._empty_response_size_bytes = response_size_bytes(
            serialize_json({"columns": columns, "rows": []})
        )

    def add_row(self, row: list[Any]) -> bool:
        """Add one row if its compact UTF-8 encoding still fits the response cap."""
        serialized_row = serialize_json(row)
        row_size = len(serialized_row.encode("utf-8"))
        added_size = row_size + (1 if self.rows else 0)
        if (
            self._empty_response_size_bytes
            + self._row_content_size_bytes
            + added_size
            > self.maximum_response_bytes
        ):
            return False

        self.rows.append(row)
        self._serialized_row_sizes.append(row_size)
        self._row_content_size_bytes += added_size
        return True

    def build(
        self,
        maximum_rows: int,
        row_limit_truncated: bool,
        response_size_truncated: bool,
    ) -> dict[str, Any]:
        """Return a final response that includes truncation metadata within the cap."""
        size_truncated = response_size_truncated
        while True:
            is_truncated = size_truncated or row_limit_truncated
            payload = self._build_payload(maximum_rows, is_truncated, size_truncated)
            base_response_size = self._base_response_size(payload, is_truncated)
            if (
                base_response_size + self._row_content_size_bytes
                <= self.maximum_response_bytes
            ):
                payload["rows"] = self.rows
                return payload
            self._remove_last_row()
            size_truncated = True

    def _build_payload(
        self,
        maximum_rows: int,
        is_truncated: bool,
        size_truncated: bool,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"columns": self.columns, "rows": []}
        if not is_truncated:
            return payload

        reason = "max_response_bytes" if size_truncated else "row_limit"
        payload["truncated"] = True
        payload["truncation"] = self._truncation_details(maximum_rows, reason)
        return payload

    def _truncation_details(self, maximum_rows: int, reason: str) -> dict[str, Any]:
        truncation: dict[str, Any] = {
            "maximumRows": maximum_rows,
            "reason": reason,
        }
        if reason == "max_response_bytes":
            truncation["maximumResponseBytes"] = self.maximum_response_bytes
        return truncation

    def _base_response_size(
        self,
        payload: dict[str, Any],
        is_truncated: bool,
    ) -> int:
        if not is_truncated:
            return self._empty_response_size_bytes
        return response_size_bytes(serialize_json(payload))

    def _remove_last_row(self) -> None:
        if not self.rows:
            raise CatalogResponseTooLarge()

        self.rows.pop()
        removed_row_size = self._serialized_row_sizes.pop()
        self._row_content_size_bytes -= removed_row_size
        if self.rows:
            self._row_content_size_bytes -= 1


def sample_table(
    spark: SparkSession,
    catalog: str,
    schema: str,
    table: str,
    limit: int,
    maximum_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
) -> dict[str, Any]:
    """Return at most 100 rows and fit the response under the configured byte cap."""
    bounded_limit = max(1, min(limit, MAX_SAMPLE_ROWS))
    frame = spark.sql(
        f"SELECT * FROM {qualified_identifier(catalog, schema, table)} "
        f"LIMIT {bounded_limit + 1}"
    )
    fields = frame.schema.fields
    columns = [
        {"name": field.name, "type": field.dataType.simpleString()}
        for field in fields
    ]
    response = SampleResponseBuilder(columns, maximum_response_bytes)
    row_limit_truncated, response_size_truncated = collect_sample_rows(
        frame,
        response,
        bounded_limit,
        fields,
    )
    return response.build(
        bounded_limit,
        row_limit_truncated,
        response_size_truncated,
    )


def collect_sample_rows(
    frame: Any,
    response: SampleResponseBuilder,
    bounded_limit: int,
    fields: list[Any],
) -> tuple[bool, bool]:
    """Read rows until the limit or encoded response cap is reached."""
    row_limit_truncated = False
    response_size_truncated = False
    for row in frame.toLocalIterator():
        if len(response.rows) == bounded_limit:
            row_limit_truncated = True
            break
        if not response.add_row(serialize_sample_row(row, fields)):
            response_size_truncated = True
            break
    return row_limit_truncated, response_size_truncated


def serialize_sample_row(row: Any, fields: list[Any]) -> list[Any]:
    """Serialize one Spark row according to its schema without losing names."""
    row_mapping = row.asDict(recursive=False) if hasattr(row, "asDict") else None
    if isinstance(row_mapping, Mapping):
        return [
            serialize_spark_value(row_mapping.get(field.name), field.dataType)
            for field in fields
        ]
    if isinstance(row, Mapping):
        return [
            serialize_spark_value(row.get(field.name), field.dataType)
            for field in fields
        ]
    values = list(row)
    return [
        serialize_spark_value(value, fields[index].dataType)
        for index, value in enumerate(values)
    ]
