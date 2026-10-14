"""Type-aware JSON conversion and sanitization for Spark catalog data."""

import base64
import datetime
import decimal
import json
import math
import re
from collections.abc import Mapping
from typing import Any

DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_CONFIGURED_RESPONSE_BYTES = 64 * 1024 * 1024
_UNHANDLED_SCHEMA_TYPE = object()

SENSITIVE_PROPERTY_PATTERN = re.compile(
    r"(password|secret|token|credential|signature|api[._-]?key|"
    r"access[._-]?key|private[._-]?key|aws[._-]?access[._-]?key[._-]?id)",
    re.IGNORECASE,
)


def serialize_json(payload: Any) -> str:
    """Serialize JSON using standards-compliant numbers and compact UTF-8 text."""
    return json.dumps(
        payload,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    )


def response_size_bytes(response: str) -> int:
    """Count the UTF-8 response bytes, including the terminating newline."""
    return len((response + "\n").encode("utf-8"))


def serialize_spark_value(value: Any, data_type: Any = None) -> Any:
    """Recursively map Spark SQL values to predictable JSON-compatible values."""
    if value is None:
        return None

    type_name = type(data_type).__name__ if data_type is not None else ""
    schema_value = serialize_spark_schema_value(value, data_type, type_name)
    if schema_value is not _UNHANDLED_SCHEMA_TYPE:
        return schema_value
    return serialize_python_value(value)


def serialize_spark_schema_value(value: Any, data_type: Any, type_name: str) -> Any:
    """Serialize values whose Spark schema determines their output shape."""
    if type_name == "StructType":
        return serialize_struct_value(value, data_type.fields)
    if type_name == "ArrayType":
        return [serialize_spark_value(item, data_type.elementType) for item in value]
    if type_name == "MapType":
        return serialize_spark_map(value, data_type.keyType, data_type.valueType)
    return _UNHANDLED_SCHEMA_TYPE


def serialize_struct_value(value: Any, fields: list[Any]) -> dict[str, Any]:
    """Serialize a Spark struct using its declared field names and types."""
    row_mapping = value.asDict(recursive=False) if hasattr(value, "asDict") else value
    if not isinstance(row_mapping, Mapping):
        row_mapping = dict(zip((field.name for field in fields), value))
    return {
        field.name: serialize_spark_value(
            row_mapping.get(field.name),
            field.dataType,
        )
        for field in fields
    }


def serialize_python_value(value: Any) -> Any:
    """Serialize common Python values after Spark-specific schema handling."""
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, datetime.datetime):
        return value.isoformat()
    if isinstance(value, datetime.date):
        return value.isoformat()
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if isinstance(value, float):
        return serialize_float(value)
    if hasattr(value, "asDict"):
        return serialize_spark_value(value.asDict(recursive=False))
    if isinstance(value, Mapping):
        return serialize_spark_map(value)
    if isinstance(value, (list, tuple)):
        return [serialize_spark_value(item) for item in value]
    if isinstance(value, (str, int, bool)):
        return value
    raise TypeError(f"Unsupported Spark value type: {type(value).__name__}")


def serialize_float(value: float) -> float | str:
    """Encode non-finite floats as stable strings accepted by JSON clients."""
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    return value


def serialize_spark_map(
    value: Mapping[Any, Any],
    key_type: Any = None,
    value_type: Any = None,
) -> Any:
    """Encode string-key maps as objects and other maps as typed key-value pairs."""
    if all(isinstance(key, str) for key in value):
        return {
            key: serialize_spark_value(item, value_type)
            for key, item in value.items()
        }
    return [
        [
            serialize_spark_value(key, key_type),
            serialize_spark_value(item, value_type),
        ]
        for key, item in value.items()
    ]


def redact_metadata_value(value: str) -> str:
    """Redact URI user information and common secret assignments."""
    redacted = re.sub(
        r"(?i)([a-z][a-z0-9+.-]*://)[^/@\s]+@",
        lambda match: match.group(1) + "[REDACTED]@",
        value,
    )
    return re.sub(
        r"""(?i)\b(password|secret|token|credential|signature|api[._-]?key|access[._-]?key|private[._-]?key|aws[._-]?access[._-]?key[._-]?id)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^,;\s]+)""",
        lambda match: match.group(1) + match.group(2) + "[REDACTED]",
        redacted,
    )


def json_value(value: Any) -> Any:
    """Serialize a Spark value when a standard JSON encoder needs help."""
    return serialize_spark_value(value)
