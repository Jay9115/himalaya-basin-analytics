import unittest
from datetime import datetime, date
import sys
from pathlib import Path

# Add backend directory to sys.path
sys.path.insert(0, str(Path(__file__).parent))

from main import parse_and_normalize_date, format_date_indian
from project_workspace.repository import format_timestamp_indian
from custom_operations.data_access import _parse_date
from custom_operations.large_worker import _date_start, _date_after


class TestIndianDateFormat(unittest.TestCase):
    def test_parse_and_normalize_date_indian_format(self):
        # Indian format dd-mm-yyyy
        self.assertEqual(parse_and_normalize_date("15-05-2024"), "2024-05-15")
        self.assertEqual(parse_and_normalize_date("01-01-2020"), "2020-01-01")
        self.assertEqual(parse_and_normalize_date("31-12-2023"), "2023-12-31")

    def test_parse_and_normalize_date_iso_format(self):
        # ISO format yyyy-mm-dd
        self.assertEqual(parse_and_normalize_date("2024-05-15"), "2024-05-15")
        self.assertEqual(parse_and_normalize_date("2020-01-01"), "2020-01-01")

    def test_format_date_indian(self):
        # Format string
        self.assertEqual(format_date_indian("2024-05-15"), "15-05-2024")
        self.assertEqual(format_date_indian("15-05-2024"), "15-05-2024")
        # Format date and datetime objects
        self.assertEqual(format_date_indian(date(2024, 5, 15)), "15-05-2024")
        self.assertEqual(format_date_indian(datetime(2024, 5, 15, 10, 30)), "15-05-2024")

    def test_format_timestamp_indian(self):
        ts = "2026-09-09T01:45:30Z"
        formatted = format_timestamp_indian(ts)
        self.assertEqual(formatted, "09-09-2026 01:45:30")

    def test_custom_operations_parse_date(self):
        self.assertEqual(_parse_date("15-05-2024", "date"), "2024-05-15")
        self.assertEqual(_parse_date("2024-05-15", "date"), "2024-05-15")

    def test_large_worker_dates(self):
        self.assertEqual(_date_start("15-05-2024"), "2024-05-15 00:00:00")
        self.assertEqual(_date_after("15-05-2024"), "2024-05-16 00:00:00")


if __name__ == "__main__":
    unittest.main()
