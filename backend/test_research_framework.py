import tempfile
import unittest
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from custom_operations.data_access import OperationBackendHooks, OperationDataLoader
from research_studio.framework_analysis import ResearchFrameworkService
from research_studio.framework_models import ResearchFrameworkRequest


class ResearchFrameworkTests(unittest.TestCase):
    def test_general_variables_relationships_and_derived_exports(self):
        with tempfile.TemporaryDirectory() as temporary:
            app_root = Path(temporary)
            data_root = app_root / "Database" / "synthetic"
            data_root.mkdir(parents=True)
            source = data_root / "synthetic.parquet"
            rows = []
            dates = {}
            for year in range(2000, 2013):
                date = f"{year}-07-01"
                dates[date] = [str(source)]
                for latitude in (33.0, 34.0):
                    for longitude in (75.0, 76.0):
                        driver = year - 1999 + latitude * 0.1
                        rows.append(
                            {
                                "date": pd.Timestamp(date),
                                "latitude": latitude,
                                "longitude": longitude,
                                "elevation_m": 2500 + latitude,
                                "response": 2.5 * driver + longitude * 0.02,
                                "driver": driver,
                            }
                        )
            pd.DataFrame(rows).to_parquet(source, index=False)
            state = {
                "id": "synthetic",
                "label": "Synthetic variables",
                "storage": "parquet",
                "path": data_root,
                "date_index": dates,
                "variables": ["response", "driver"],
                "default_variable": "response",
                "date_col": "date",
                "lat_col": "latitude",
                "lon_col": "longitude",
                "elev_col": "elevation_m",
            }

            hooks = OperationBackendHooks(
                ensure_dataset_loaded=lambda dataset, **_: state,
                validate_variable=lambda dataset_state, variable: variable or dataset_state["default_variable"],
                resolve_elevation_bounds=lambda _state, lower, upper: (float(lower), float(upper)),
                normalize_year_range=lambda lower, upper: (lower, upper),
                get_subregion=lambda _identifier: None,
                query_data=lambda *_args, **_kwargs: [],
            )
            service = ResearchFrameworkService(app_root, OperationDataLoader(hooks))
            request = ResearchFrameworkRequest.model_validate(
                {
                    "variables": [
                        {"dataset": "synthetic", "variable": "response", "aggregation": "mean"},
                        {"dataset": "synthetic", "variable": "driver", "aggregation": "mean"},
                    ],
                    "year_start": 2000,
                    "year_end": 2012,
                    "baseline_start": 2000,
                    "baseline_end": 2009,
                    "recent_start": 2010,
                    "elev_min": 0,
                    "elev_max": 9000,
                    "methods": ["descriptive", "trend", "anomaly", "emergence", "change_point", "relationships", "compound"],
                    "max_map_points": 1000,
                }
            )

            result = service.analyze(request)

            self.assertEqual(result["framework"], "Generalized selection-aware research workflow")
            self.assertEqual(len(result["variables"]), 2)
            self.assertEqual(result["coverage"]["year_count"], 13)
            self.assertGreater(result["relationships"][0]["regional"]["pearson_r"], 0.99)
            self.assertEqual(result["relationships"][0]["spatial"]["n"], 4)
            self.assertTrue(any(layer["id"].startswith("relationship_") for layer in result["layers"]))
            self.assertFalse(result["provenance"]["raw_data_modified"])
            run_dir = service.run_dir(result["run_id"])
            self.assertTrue((run_dir / "annual_series.csv").is_file())
            self.assertTrue((run_dir / "pixel_metrics.parquet").is_file())
            self.assertTrue((run_dir / "relationships.csv").is_file())
            self.assertTrue(source.is_file())


if __name__ == "__main__":
    unittest.main()
