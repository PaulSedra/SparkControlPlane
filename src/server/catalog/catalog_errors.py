"""Credential-safe errors and diagnostics for Spark catalog operations."""

import re
import sys


class CatalogConfigurationError(RuntimeError):
    """Raised when the catalog adapter has invalid runtime configuration."""


class CatalogResponseTooLarge(RuntimeError):
    """Raised when a serialized catalog response exceeds its byte limit."""


def write_warning(message: str) -> None:
    """Write a controlled diagnostic to stderr without exposing Spark errors."""
    sys.stderr.write(f"SPARK_CATALOG_WARNING: {message}\n")


def spark_error_condition(error: Exception) -> str:
    """Read a stable Spark error condition without logging exception text."""
    for method_name in ("getCondition", "getErrorClass"):
        method = getattr(error, method_name, None)
        if callable(method):
            try:
                condition = method()
            except Exception:
                continue
            if condition:
                return str(condition).upper()
    return ""


def is_permission_error(error: Exception) -> bool:
    """Recognize authorization failures before unsupported-operation checks."""
    condition = spark_error_condition(error)
    class_name = type(error).__name__.casefold()
    message = str(error).casefold()
    return (
        any(marker in condition for marker in (
            "ACCESS_DENIED",
            "NOT_AUTHORIZED",
            "PERMISSION_DENIED",
            "UNAUTHORIZED",
        ))
        or "permission" in class_name
        or "security" in class_name
        or any(marker in message for marker in (
            "access denied",
            "insufficient privilege",
            "not authorized",
            "permission denied",
            "unauthorized",
        ))
    )


def is_connection_error(error: Exception) -> bool:
    """Recognize Spark Connect and transport failures before fallback checks."""
    condition = spark_error_condition(error)
    class_name = type(error).__name__.casefold()
    message = str(error).casefold()
    return (
        isinstance(error, (ConnectionError, TimeoutError, OSError))
        or any(marker in class_name for marker in ("connect", "grpc", "transport"))
        or any(marker in condition for marker in (
            "DEADLINE_EXCEEDED",
            "UNAVAILABLE",
        ))
        or any(marker in message for marker in (
            "connection refused",
            "connection reset",
            "deadline exceeded",
            "network is unreachable",
            "timed out",
            "transport is closing",
        ))
    )


def is_unsupported_spark_operation(error: Exception) -> bool:
    """Identify unsupported SQL operations without masking access or transport failures."""
    if is_permission_error(error) or is_connection_error(error):
        return False
    class_name = type(error).__name__.casefold()
    condition = spark_error_condition(error)
    message = str(error).casefold()
    return (
        isinstance(error, NotImplementedError)
        or class_name in {"notsupportederror", "unsupportedoperationexception"}
        or condition.startswith(("NOT_SUPPORTED", "UNSUPPORTED"))
        or (
            "analysisexception" in class_name
            and bool(re.search(
                r"\b(?:operation|command|statement)\b.{0,40}"
                r"\b(?:not supported|unsupported|not implemented)\b|"
                r"\b(?:not supported|unsupported|not implemented)\b.{0,40}"
                r"\b(?:operation|command|statement)\b",
                message,
            ))
        )
    )


def safe_diagnostic(error: Exception) -> tuple[str, str]:
    """Return a credential-free category and message for stderr."""
    if isinstance(error, CatalogConfigurationError):
        return "configuration", str(error)
    if isinstance(error, CatalogResponseTooLarge):
        return (
            "response_limit",
            "The catalog response exceeds SPARK_CATALOG_MAX_RESPONSE_BYTES.",
        )
    if is_permission_error(error):
        return "permission", "Spark denied the catalog operation."
    if is_connection_error(error):
        return "connection", "Spark Connect could not complete the catalog operation."
    if is_unsupported_spark_operation(error):
        return "unsupported", "Spark does not support the catalog operation."
    return (
        "unexpected",
        f"Spark catalog operation failed ({type(error).__name__}).",
    )
