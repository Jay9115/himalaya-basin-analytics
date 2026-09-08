import tempfile
import unittest
from pathlib import Path

import pandas as pd

from main import query_data


class SphyMapFilterTests(unittest.TestCase):
    def test_zero_gmel_and_smel_values_are_not_loaded_for_map(self) -> None:
        query_date = "2024-06-15"
        timestamp = pd.Timestamp(query_date)

        with tempfile.TemporaryDirectory() as temp_dir:
            parquet_path = Path(temp_dir) / "SPHY_20240615.parquet"
            pd.DataFrame(
                {
                    "date": [timestamp] * 4,
                    "latitude": [31.0, 31.1, 31.2, 31.3],
                    "longitude": [75.0, 75.1, 75.2, 75.3],
                    "elevation_m": [1000.0, 1100.0, 1200.0, 1300.0],
                    "GMel": [0.0, -0.0, 1.25, -0.5],
                    "SMel": [2.5, 0.0, -0.0, 3.5],
                }
            ).to_parquet(parquet_path, index=False)

            state = {
                "id": "sphy_model",
                "storage": "parquet",
                "date_index": {query_date: [str(parquet_path)]},
                "date_col": "date",
                "lat_col": "latitude",
                "lon_col": "longitude",
                "elev_col": "elevation_m",
                "map_exclude_zero_variables": ("GMel", "SMel"),
            }

            expected_values = {
                "GMel": [1.25, -0.5],
                "SMel": [2.5, 3.5],
            }
            for variable, expected in expected_values.items():
                with self.subTest(variable=variable):
                    records = query_data(
                        state,
                        query_date,
                        elev_min=500.0,
                        elev_max=9000.0,
                        variable=variable,
                    )
                    self.assertEqual([record["value"] for record in records], expected)

    def test_custom_rectangle_is_applied_before_map_records_are_returned(self) -> None:
        query_date = "2024-06-15"
        timestamp = pd.Timestamp(query_date)

        with tempfile.TemporaryDirectory() as temp_dir:
            parquet_path = Path(temp_dir) / "rectangle_filter.parquet"
            pd.DataFrame(
                {
                    "date": [timestamp] * 4,
                    "latitude": [31.0, 31.5, 32.0, 32.5],
                    "longitude": [75.0, 75.5, 76.0, 76.5],
                    "elevation_m": [1000.0] * 4,
                    "temperature_C": [1.0, 2.0, 3.0, 4.0],
                }
            ).to_parquet(parquet_path, index=False)

            state = {
                "id": "rectangle_test",
                "storage": "parquet",
                "date_index": {query_date: [str(parquet_path)]},
                "date_col": "date",
                "lat_col": "latitude",
                "lon_col": "longitude",
                "elev_col": "elevation_m",
                "map_exclude_zero_variables": (),
            }
            rectangle = {
                "id": "custom_bbox",
                "kind": "bbox",
                "bounds": {
                    "min_lat": 31.25,
                    "max_lat": 32.25,
                    "min_lon": 75.25,
                    "max_lon": 76.25,
                },
            }

            records = query_data(
                state,
                query_date,
                elev_min=500.0,
                elev_max=9000.0,
                variable="temperature_C",
                subregion=rectangle,
            )

            self.assertEqual([record["value"] for record in records], [2.0, 3.0])


if __name__ == "__main__":
    unittest.main()
