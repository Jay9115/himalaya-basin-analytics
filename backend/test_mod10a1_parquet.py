from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq
import rasterio
from rasterio.transform import from_origin


APP_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(APP_ROOT / "Database"))

from convert_mod10a1_to_parquet import convert_all  # noqa: E402


class Mod10A1ParquetConversionTests(unittest.TestCase):
    def test_conversion_preserves_union_grid_and_builds_preview(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_dir:
            root = Path(temporary_dir)
            source_dir = root / "source"
            output_dir = root / "output"
            source_dir.mkdir()
            source = source_dir / "MOD10A1_2024_01.tif"

            profile = {
                "driver": "GTiff",
                "width": 8,
                "height": 6,
                "count": 3,
                "dtype": "float64",
                "crs": "EPSG:4326",
                "transform": from_origin(72.5, 37.1, 0.01, 0.01),
            }
            values = np.arange(48, dtype=np.float64).reshape(6, 8)
            bands = np.stack([values, values + 100, values + 200])
            bands[0, 0, 0] = np.nan
            bands[1, 0, 1] = np.nan
            bands[2, 0, 2] = np.nan
            bands[:, 1, 1] = np.nan

            with rasterio.open(source, "w", **profile) as dataset:
                dataset.write(bands)
                dataset.descriptions = (
                    "Snow_Albedo_Daily_Tile",
                    "NDSI_Snow_Cover",
                    "NDSI_Snow_Cover_Basic_QA",
                )

            manifest = convert_all(
                source_dir,
                output_dir,
                overwrite=False,
                verify_only=False,
                max_map_points=8,
                row_group_size=16,
            )

            output = output_dir / "MOD10A1_2024_01.parquet"
            table = pq.read_table(output)
            self.assertEqual(manifest["file_count"], 1)
            self.assertEqual(table.num_rows, 47)
            self.assertEqual(table["date"].unique().to_pylist()[0].strftime("%Y-%m-%d"), "2024-01-01")
            self.assertLessEqual(int(table["_map_sample"].to_numpy().sum()), 8)
            self.assertEqual(table["Snow_Albedo_Daily_Tile"].null_count, 1)
            self.assertEqual(table["NDSI_Snow_Cover"].null_count, 1)
            self.assertEqual(table["NDSI_Snow_Cover_Basic_QA"].null_count, 1)
            self.assertTrue((output_dir / "manifest.json").exists())


if __name__ == "__main__":
    unittest.main()
