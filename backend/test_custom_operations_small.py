import tempfile
import unittest
from pathlib import Path

import pandas as pd

from custom_operations.data_access import dataframe_to_worker_payload
from custom_operations.sandbox import LocalSubprocessSandbox


class SmallOperationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.sandbox = LocalSubprocessSandbox(Path(self.temp_dir.name))
        self.frame_payload = dataframe_to_worker_payload(
            pd.DataFrame(
                [
                    {"date": "2024-01-01", "value": 10.0},
                    {"date": "2024-01-02", "value": 20.0},
                ]
            )
        )
        self.meta = {"dataset_label": "Small test dataset", "row_count": 2}

    def run_code(self, job_id: str, code: str):
        return self.sandbox.run(
            job_id=job_id,
            code=code,
            frame_payload=self.frame_payload,
            meta=self.meta,
            timeout_seconds=10,
        )

    def test_small_code_returns_terminal_and_structured_output(self) -> None:
        result = self.run_code(
            "small-success",
            """
def run(hb, df, meta):
    print(f"rows={len(df)}")
    hb.number("mean", df["value"].mean())
""",
        )

        self.assertTrue(result["ok"], result.get("error"))
        self.assertEqual(result["status"], "completed")
        self.assertIn("rows=2", result["stdout"])
        self.assertEqual(result["outputs"][0]["type"], "number")

    def test_error_preserves_output_and_original_traceback(self) -> None:
        result = self.run_code(
            "small-error",
            """
def run(hb, df, meta):
    print("analysis started")
    raise ValueError("bad scientific input")
""",
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["status"], "error")
        self.assertIn("analysis started", result["stdout"])
        self.assertIn("ValueError: bad scientific input", result["error"])


if __name__ == "__main__":
    unittest.main()
