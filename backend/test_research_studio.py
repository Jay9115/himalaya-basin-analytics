import tempfile
import unittest
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from research_studio.analysis import ResearchService, bh_qvalues
from research_studio.models import ResearchAnalysisRequest


APP_ROOT = Path(__file__).resolve().parent.parent


class ResearchStudioTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.service = ResearchService(APP_ROOT)
        self.service.output_root = Path(self.temp_dir.name).resolve()

    def test_capabilities_expose_verified_products_and_methods(self) -> None:
        capabilities = self.service.capabilities()
        datasets = {item["id"]: item for item in capabilities["datasets"]}
        self.assertIn("era5_annual", datasets)
        self.assertIn("chirps_annual", datasets)
        self.assertEqual(datasets["era5_annual"]["years"], [1981, 2025])
        self.assertFalse(capabilities["source_data_modified"])
        self.assertGreaterEqual(len(capabilities["methods"]), 5)

    def test_bh_qvalues_are_monotonic_in_rank_order(self) -> None:
        p_values = np.array([0.03, 0.001, 0.20, np.nan, 0.04])
        q_values = bh_qvalues(p_values)
        ranked = np.argsort(p_values[np.isfinite(p_values)])
        valid_q = q_values[np.isfinite(p_values)][ranked]
        self.assertTrue(np.all(np.diff(valid_q) >= -1e-12))
        self.assertTrue(np.isnan(q_values[3]))

    def test_cross_product_analysis_creates_reproducible_artifacts(self) -> None:
        result = self.service.analyze(
            ResearchAnalysisRequest(
                dataset="era5_annual",
                variable="temperature_C",
                secondary_dataset="chirps_annual",
                secondary_variable="precipitation_mm",
                year_start=1981,
                year_end=2025,
                baseline_start=1981,
                baseline_end=2010,
                basin=20,
                max_map_points=3000,
            )
        )
        run_dir = self.service.run_dir(result["run_id"])
        self.assertEqual(result["secondary_variable"]["source"], "CHIRPS")
        self.assertIn("nearest cell", result["harmonization"])
        self.assertGreaterEqual(result["coverage"]["year_count"], 40)
        self.assertGreater(result["coverage"]["pixel_count"], 100)
        self.assertTrue((run_dir / "annual_series.csv").is_file())
        self.assertTrue((run_dir / "pixel_metrics.parquet").is_file())
        self.assertTrue((run_dir / "request.json").is_file())
        self.assertTrue((run_dir / "summary.json").is_file())
        self.assertEqual({layer["id"] for layer in result["layers"]}, {"trend", "anomaly", "emergence", "change_point"})

    def test_run_path_rejects_traversal(self) -> None:
        with self.assertRaises(ValueError):
            self.service.run_dir("../outside")


if __name__ == "__main__":
    unittest.main()
