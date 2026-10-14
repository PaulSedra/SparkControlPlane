"""Unit coverage for the Spark Connect catalog Python adapter."""

import contextlib
import datetime
import decimal
import importlib.util
import io
import json
import os
import sys
import types
import unittest
from unittest import mock


class FakeRow:
    """A small Spark Row substitute for deterministic adapter tests."""

    def __init__(self, *values, **named_values):
        self.values = values
        self.named_values = named_values

    def __iter__(self):
        return iter(self.values)

    def asDict(self, recursive=True):
        del recursive
        return dict(self.named_values)


class FakeResult:
    """A Spark result substitute whose rows are already bounded."""

    def __init__(self, rows):
        self.rows = rows

    def collect(self):
        raise AssertionError("Catalog queries must consume Spark rows incrementally.")

    def toLocalIterator(self):
        return iter(self.rows)


class FakeSpark:
    """A Spark session substitute that records SQL and returns one result."""

    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.queries = []

    def sql(self, query):
        self.queries.append(query)
        if self.error is not None:
            raise self.error
        return self.result

    def stop(self):
        pass


class FakeField:
    """A Spark schema field substitute."""

    def __init__(self, name, data_type):
        self.name = name
        self.dataType = data_type


class FakeSchema:
    """A Spark schema substitute."""

    def __init__(self, fields):
        self.fields = fields


class FakeFrame:
    """A DataFrame substitute for sample response tests."""

    def __init__(self, fields, rows):
        self.schema = FakeSchema(fields)
        self.rows = rows

    def collect(self):
        raise AssertionError("Catalog samples must consume Spark rows incrementally.")

    def toLocalIterator(self):
        return iter(self.rows)


class StringType:
    def simpleString(self):
        return "string"


class IntegerType:
    def simpleString(self):
        return "int"


class DoubleType:
    def simpleString(self):
        return "double"


class DecimalType:
    def simpleString(self):
        return "decimal(38,4)"


class TimestampType:
    def simpleString(self):
        return "timestamp"


class DateType:
    def simpleString(self):
        return "date"


class BinaryType:
    def simpleString(self):
        return "binary"


class ArrayType:
    def __init__(self, element_type):
        self.elementType = element_type

    def simpleString(self):
        return "array"


class MapType:
    def __init__(self, key_type, value_type):
        self.keyType = key_type
        self.valueType = value_type

    def simpleString(self):
        return "map"


class StructType:
    def __init__(self, fields):
        self.fields = fields

    def simpleString(self):
        return "struct"


class UnsupportedOperationException(Exception):
    pass


class AccessDeniedException(Exception):
    def getCondition(self):
        return "PERMISSION_DENIED"


def load_catalog_module(script_path):
    """Import the adapter with a minimal pyspark module in place."""
    spark_module = types.ModuleType("pyspark")
    sql_module = types.ModuleType("pyspark.sql")
    sql_module.Row = FakeRow
    sql_module.SparkSession = object
    spark_module.sql = sql_module
    sys.modules["pyspark"] = spark_module
    sys.modules["pyspark.sql"] = sql_module
    catalog_directory = os.path.dirname(os.path.abspath(script_path))
    if catalog_directory not in sys.path:
        sys.path.insert(0, catalog_directory)

    module_spec = importlib.util.spec_from_file_location(
        "spark_connect_catalog",
        script_path,
    )
    module = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(module)
    return module


catalog = load_catalog_module(sys.argv[1])
metadata = sys.modules["catalog_metadata"]
serialization = sys.modules["catalog_serialization"]
sampling = sys.modules["catalog_sampling"]
errors = sys.modules["catalog_errors"]
sys.argv = sys.argv[:1]


class SparkCatalogMetadataTest(unittest.TestCase):
    def test_partition_columns_are_separate_and_deduplicated(self):
        rows = [
            FakeRow("# col_name", "data_type", "comment"),
            FakeRow("id", "bigint", ""),
            FakeRow("region", "string", ""),
            FakeRow("# Partition Information", "", ""),
            FakeRow("# col_name", "data_type", "comment"),
            FakeRow("region", "string", "partition key"),
            FakeRow("# Detailed Table Information", "", ""),
            FakeRow("Type", "MANAGED", ""),
            FakeRow("Provider", "iceberg", ""),
        ]
        detail = metadata.describe_table(
            FakeSpark(FakeResult(rows)),
            "example",
            "silver",
            "events",
        )

        self.assertEqual(
            detail["columns"],
            [{"name": "id", "type": "bigint"}, {"name": "region", "type": "string"}],
        )
        self.assertEqual(detail["partitionColumns"], ["region"])
        self.assertEqual(detail["tableType"], "TABLE")
        self.assertEqual(detail["properties"]["Provider"], "iceberg")

    def test_view_metadata_classifies_and_returns_definition(self):
        rows = [
            FakeRow("# col_name", "data_type", "comment"),
            FakeRow("event_id", "bigint", ""),
            FakeRow("# Detailed Table Information", "", ""),
            FakeRow("Type", "VIEW", ""),
            FakeRow(
                "View Original Text",
                "SELECT token='private-value' FROM source",
                "",
            ),
        ]
        detail = metadata.describe_table(
            FakeSpark(FakeResult(rows)),
            "example",
            "silver",
            "event_view",
        )

        self.assertEqual(detail["tableType"], "VIEW")
        self.assertEqual(
            detail["viewDefinition"],
            "SELECT token=[REDACTED] FROM source",
        )

    def test_missing_type_and_detailed_metadata_return_unknown(self):
        rows = [
            FakeRow("# col_name", "data_type", "comment"),
            FakeRow("event_id", "bigint", ""),
        ]
        detail = metadata.describe_table(
            FakeSpark(FakeResult(rows)),
            "example",
            "silver",
            "events",
        )

        self.assertEqual(detail["tableType"], "UNKNOWN")
        self.assertEqual(detail["properties"], {})
        self.assertEqual(detail["columns"], [{"name": "event_id", "type": "bigint"}])

    def test_property_parser_handles_quotes_nested_values_and_equals(self):
        parsed = metadata.parse_table_properties(
            '[note="comma, equals=inside", '
            'nested={items=[one,two], expression="a=b,c=d"}, '
            'literal=left=middle=right, plain=one, two words]'
        )

        self.assertEqual(parsed["note"], '"comma, equals=inside"')
        self.assertEqual(
            parsed["nested"],
            '{items=[one,two], expression="a=b,c=d"}',
        )
        self.assertEqual(parsed["literal"], "left=middle=right")
        self.assertEqual(parsed["plain"], "one, two words")

    def test_nested_spark_types_serialize_recursively_to_valid_json(self):
        nested_type = StructType([
            FakeField("name", StringType()),
            FakeField("scores", ArrayType(DoubleType())),
        ])
        fields = [
            FakeField("profile", nested_type),
            FakeField("attributes", MapType(StringType(), IntegerType())),
            FakeField("amount", DecimalType()),
            FakeField("created_at", TimestampType()),
            FakeField("event_date", DateType()),
            FakeField("measurement", DoubleType()),
            FakeField("integer_map", MapType(IntegerType(), StringType())),
        ]
        row = FakeRow(
            profile=FakeRow(name="Ada", scores=[1.5, float("nan")]),
            attributes={"region": 3},
            amount=decimal.Decimal("12345678901234567890.1200"),
            created_at=datetime.datetime(
                2026,
                9,
                27,
                12,
                30,
                tzinfo=datetime.timezone.utc,
            ),
            event_date=datetime.date(2026, 9, 27),
            measurement=float("inf"),
            integer_map={1: "one"},
        )

        serialized = sampling.serialize_sample_row(row, fields)
        encoded = serialization.serialize_json({"rows": [serialized]})
        decoded = json.loads(encoded)

        self.assertEqual(decoded["rows"][0][0]["name"], "Ada")
        self.assertEqual(decoded["rows"][0][0]["scores"], [1.5, "NaN"])
        self.assertEqual(decoded["rows"][0][1], {"region": 3})
        self.assertEqual(decoded["rows"][0][2], "12345678901234567890.1200")
        self.assertEqual(decoded["rows"][0][3], "2026-09-27T12:30:00+00:00")
        self.assertEqual(decoded["rows"][0][4], "2026-09-27")
        self.assertEqual(decoded["rows"][0][5], "Infinity")
        self.assertEqual(decoded["rows"][0][6], [[1, "one"]])
        self.assertNotIn(":NaN", encoded)
        self.assertNotIn(":Infinity", encoded)

    def test_binary_spark_values_use_base64(self):
        self.assertEqual(
            serialization.serialize_spark_value(b"\x00\xff", BinaryType()),
            "AP8=",
        )

    def test_sample_size_accounting_accepts_exact_utf8_response_boundary(self):
        columns = [{"name": "value", "type": "string"}]
        expected = {"columns": columns, "rows": [["é"]]}
        exact_limit = serialization.response_size_bytes(
            serialization.serialize_json(expected)
        )
        builder = sampling.SampleResponseBuilder(columns, exact_limit)

        self.assertTrue(builder.add_row(["é"]))
        response = builder.build(1, False, False)

        self.assertEqual(response, expected)
        self.assertEqual(
            serialization.response_size_bytes(
                serialization.serialize_json(response)
            ),
            exact_limit,
        )

        too_small = sampling.SampleResponseBuilder(columns, exact_limit - 1)
        self.assertFalse(too_small.add_row(["é"]))
        with self.assertRaises(errors.CatalogResponseTooLarge):
            too_small.build(1, False, True)

    def test_sample_serializes_each_row_once_when_tracking_the_size(self):
        frame = FakeFrame(
            [FakeField("value", IntegerType())],
            [FakeRow(value=index) for index in range(101)],
        )
        spark = FakeSpark(frame)

        with mock.patch.object(
            sampling,
            "serialize_json",
            wraps=serialization.serialize_json,
        ) as serializer:
            sample = sampling.sample_table(
                spark,
                "example",
                "silver",
                "events",
                100,
                8192,
            )

        self.assertEqual(len(sample["rows"]), 100)
        self.assertEqual(serializer.call_count, 102)

    def test_sample_response_stays_under_byte_limit_and_reports_truncation(self):
        frame = FakeFrame(
            [FakeField("payload", StringType())],
            [
                FakeRow(payload="a" * 200),
                FakeRow(payload="b" * 5000),
            ],
        )
        spark = FakeSpark(frame)

        sample = sampling.sample_table(
            spark,
            "example",
            "silver",
            "events",
            2,
            1024,
        )
        encoded = serialization.serialize_json(sample)

        self.assertEqual(spark.queries[-1].rsplit(" ", 1)[-1], "3")
        self.assertLessEqual(serialization.response_size_bytes(encoded), 1024)
        self.assertEqual(len(sample["rows"]), 1)
        self.assertTrue(sample["truncated"])
        self.assertEqual(
            sample["truncation"]["reason"],
            "max_response_bytes",
        )
        self.assertEqual(
            sample["truncation"]["maximumResponseBytes"],
            1024,
        )

    def test_sample_response_reports_the_100_row_limit(self):
        frame = FakeFrame(
            [FakeField("value", IntegerType())],
            [FakeRow(value=index) for index in range(101)],
        )
        spark = FakeSpark(frame)

        sample = sampling.sample_table(
            spark,
            "example",
            "silver",
            "events",
            100,
            8192,
        )

        self.assertEqual(len(sample["rows"]), 100)
        self.assertTrue(sample["truncated"])
        self.assertEqual(sample["truncation"]["reason"], "row_limit")
        self.assertEqual(sample["truncation"]["maximumRows"], 100)
        self.assertTrue(spark.queries[-1].endswith("LIMIT 101"))

    def test_table_listing_degrades_only_for_unsupported_metadata(self):
        unsupported = FakeSpark(error=UnsupportedOperationException())
        warning_stream = io.StringIO()
        delimiter = chr(96)
        namespace = delimiter + "example" + delimiter + "." + delimiter + "silver" + delimiter
        with contextlib.redirect_stderr(warning_stream):
            self.assertEqual(metadata.table_types(unsupported, namespace), {})
        self.assertIn("SPARK_CATALOG_WARNING:", warning_stream.getvalue())

        for error in (
            AccessDeniedException("permission denied"),
            ConnectionError("connection reset"),
            RuntimeError("unexpected operation failure"),
        ):
            with self.subTest(error=type(error).__name__):
                with self.assertRaises(type(error)):
                    metadata.table_types(FakeSpark(error=error), namespace)

    def test_table_listing_classifies_views_and_keeps_unknown_metadata_unknown(self):
        rows = [
            FakeRow(tableName="view_asset", information="Type: VIEW"),
            FakeRow(tableName="managed_asset", information="Type: MANAGED"),
            FakeRow(tableName="unknown_asset", information="Provider: iceberg"),
        ]
        delimiter = chr(96)
        namespace = delimiter + "example" + delimiter + "." + delimiter + "silver" + delimiter

        types_by_name = metadata.table_types(
            FakeSpark(FakeResult(rows)),
            namespace,
        )

        self.assertEqual(types_by_name["view_asset"], "VIEW")
        self.assertEqual(types_by_name["managed_asset"], "TABLE")
        self.assertEqual(types_by_name["unknown_asset"], "UNKNOWN")

    def test_extended_describe_falls_back_only_when_unsupported(self):
        basic_result = FakeResult([
            FakeRow("# col_name", "data_type", "comment"),
            FakeRow("event_id", "bigint", ""),
        ])

        class FallbackSpark(FakeSpark):
            def sql(self, query):
                self.queries.append(query)
                if "EXTENDED" in query:
                    raise UnsupportedOperationException()
                return basic_result

        spark = FallbackSpark()
        warning_stream = io.StringIO()
        with contextlib.redirect_stderr(warning_stream):
            detail = metadata.describe_table(
                spark,
                "example",
                "silver",
                "events",
            )

        self.assertEqual(len(spark.queries), 2)
        self.assertTrue(spark.queries[-1].startswith("DESCRIBE TABLE "))
        self.assertEqual(detail["tableType"], "UNKNOWN")
        self.assertIn("SPARK_CATALOG_WARNING:", warning_stream.getvalue())

        with self.assertRaises(AccessDeniedException):
            metadata.describe_table(
                FakeSpark(error=AccessDeniedException("permission denied")),
                "example",
                "silver",
                "events",
            )

    def test_identifier_quoting_escapes_embedded_backticks(self):
        delimiter = chr(96)
        catalog_name = "catalog`name"
        table_name = "table`name"
        self.assertEqual(
            metadata.qualified_identifier(catalog_name, "schema", table_name),
            delimiter + "catalog" + delimiter * 2 + "name" + delimiter + "." +
            delimiter + "schema" + delimiter + "." +
            delimiter + "table" + delimiter * 2 + "name" + delimiter,
        )

    def test_metadata_filters_sensitive_keys_and_redacts_credentials(self):
        safe = metadata.safe_metadata_properties({
            "password": "private-value",
            "format": "iceberg",
            "location": (
                "s3a://user:private-value@bucket/path?"
                "X-Amz-Signature=private-value"
            ),
            "notes": "token=private-value",
        })

        self.assertNotIn("password", safe)
        self.assertEqual(safe["format"], "iceberg")
        self.assertNotIn("private-value", safe["location"])
        self.assertNotIn("private-value", safe["notes"])

    def test_maximum_response_setting_is_configurable_and_validated(self):
        with mock.patch.dict(
            os.environ,
            {"SPARK_CATALOG_MAX_RESPONSE_BYTES": "2048"},
            clear=False,
        ):
            self.assertEqual(catalog.configured_max_response_bytes(), 2048)

        with mock.patch.dict(
            os.environ,
            {"SPARK_CATALOG_MAX_RESPONSE_BYTES": "0"},
            clear=False,
        ):
            with self.assertRaises(errors.CatalogConfigurationError):
                catalog.configured_max_response_bytes()

    def test_cli_emits_json_to_stdout_and_sanitized_errors_on_stderr(self):
        catalog_environment = {"SPARK_CONNECT_URL": "sc://user:private-value@host"}
        success_spark = FakeSpark(FakeResult([FakeRow(catalog="spark_catalog")]))

        class SuccessBuilder:
            def remote(self, connect_url):
                self.connect_url = connect_url
                return self

            def getOrCreate(self):
                return success_spark

        class SuccessSession:
            builder = SuccessBuilder()

        original_session = catalog.SparkSession
        catalog.SparkSession = SuccessSession
        try:
            with mock.patch.dict(os.environ, catalog_environment, clear=False):
                with mock.patch.object(
                    sys,
                    "argv",
                    ["spark_connect_catalog.py", "catalogs"],
                ):
                    stdout = io.StringIO()
                    stderr = io.StringIO()
                    with contextlib.redirect_stdout(stdout):
                        with contextlib.redirect_stderr(stderr):
                            catalog.main()
            self.assertEqual(json.loads(stdout.getvalue()), {
                "catalogs": [{"name": "spark_catalog"}],
            })
            self.assertTrue(stdout.getvalue().endswith("\n"))
            self.assertEqual(stderr.getvalue(), "")
        finally:
            catalog.SparkSession = original_session

        class FailingBuilder:
            def remote(self, connect_url):
                self.connect_url = connect_url
                return self

            def getOrCreate(self):
                raise ConnectionError(
                    "failed to connect to sc://user:private-value@host"
                )

        class FailingSession:
            builder = FailingBuilder()

        catalog.SparkSession = FailingSession
        try:
            with mock.patch.dict(os.environ, catalog_environment, clear=False):
                with mock.patch.object(
                    sys,
                    "argv",
                    ["spark_connect_catalog.py", "catalogs"],
                ):
                    stdout = io.StringIO()
                    stderr = io.StringIO()
                    with contextlib.redirect_stdout(stdout):
                        with contextlib.redirect_stderr(stderr):
                            result = catalog.run_cli()
            self.assertEqual(result, 1)
            self.assertEqual(stdout.getvalue(), "")
            self.assertIn("SPARK_CATALOG_ERROR: connection:", stderr.getvalue())
            self.assertNotIn("private-value", stderr.getvalue())
        finally:
            catalog.SparkSession = original_session


    def test_cli_detail_response_keeps_its_json_contract_after_extraction(self):
        rows = [
            FakeRow("# col_name", "data_type", "comment"),
            FakeRow("id", "bigint", ""),
            FakeRow("region", "string", ""),
            FakeRow("# Partition Information", "", ""),
            FakeRow("# col_name", "data_type", "comment"),
            FakeRow("region", "string", ""),
            FakeRow("# Detailed Table Information", "", ""),
            FakeRow("Type", "MANAGED", ""),
            FakeRow("Provider", "iceberg", ""),
        ]
        spark = FakeSpark(FakeResult(rows))

        class SuccessBuilder:
            def remote(self, connect_url):
                self.connect_url = connect_url
                return self

            def getOrCreate(self):
                return spark

        class SuccessSession:
            builder = SuccessBuilder()

        original_session = catalog.SparkSession
        catalog.SparkSession = SuccessSession
        try:
            with mock.patch.dict(
                os.environ,
                {"SPARK_CONNECT_URL": "sc://spark"},
                clear=False,
            ):
                with mock.patch.object(
                    sys,
                    "argv",
                    [
                        "spark_connect_catalog.py",
                        "detail",
                        "--catalog",
                        "example",
                        "--schema",
                        "silver",
                        "--table",
                        "events",
                    ],
                ):
                    stdout = io.StringIO()
                    with contextlib.redirect_stdout(stdout):
                        catalog.main()
            response = json.loads(stdout.getvalue())
        finally:
            catalog.SparkSession = original_session

        self.assertEqual(response["catalog"], "example")
        self.assertEqual(response["schema"], "silver")
        self.assertEqual(response["name"], "events")
        self.assertEqual(response["tableType"], "TABLE")
        self.assertEqual(response["partitionColumns"], ["region"])
        self.assertEqual(
            response["columns"],
            [{"name": "id", "type": "bigint"}, {"name": "region", "type": "string"}],
        )
        self.assertEqual(response["properties"]["Provider"], "iceberg")
        self.assertTrue(stdout.getvalue().endswith("\n"))


if __name__ == "__main__":
    unittest.main()
