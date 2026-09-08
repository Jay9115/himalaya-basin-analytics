import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd

from custom_operations.data_access import OperationBackendHooks, OperationDataLoader
from custom_operations.large_jobs import LocalLargeOperationJobManager
from custom_operations.planner import OperationExecutionPlanner, OperationPlanPolicy
from custom_operations.schemas import OperationJobCreateRequest, OperationSelection
from custom_operations.security import validate_large_operation_code, validate_python_code


DATES = [f"{year}-01-01" for year in range(2000, 2008)]


def ensure_dataset_loaded(
    dataset: Optional[str],
    year_start: Optional[int] = None,
    year_end: Optional[int] = None,
) -> Dict[str, Any]:
    selected_dates = [
        date_key
        for date_key in DATES
        if (year_start is None or int(date_key[:4]) >= year_start)
        and (year_end is None or int(date_key[:4]) <= year_end)
    ]
    return {
        "id": dataset or "fake",
        "label": "Fake Basin Dataset",
        "storage": "memory",
        "variables": ["temperature", "snow"],
        "default_variable": "temperature",
        "date_index": {date_key: [f"{date_key}.fake"] for date_key in selected_dates},
    }


def validate_variable(state: Dict[str, Any], variable: Optional[str]) -> str:
    value = variable or state["default_variable"]
    if value not in state["variables"]:
        raise ValueError(value)
    return value


def resolve_elevation_bounds(
    _state: Dict[str, Any],
    elev_min: Optional[float],
    elev_max: Optional[float],
) -> Tuple[float, float]:
    return float(elev_min if elev_min is not None else 0), float(elev_max if elev_max is not None else 9000)


def normalize_year_range(
    year_start: Optional[int],
    year_end: Optional[int],
) -> Tuple[Optional[int], Optional[int]]:
    return year_start, year_end


def get_subregion(_subregion_id: Optional[str]) -> Optional[Dict[str, Any]]:
    return None


def query_data(
    _state: Dict[str, Any],
    query_date: str,
    elev_min: float,
    elev_max: float,
    variable: str,
    subregion: Optional[Dict[str, Any]] = None,
) -> List[Dict[str, Any]]:
    year = int(query_date[:4])
    return [
        {
            "lat": 30.0 + index,
            "lon": 78.0 + index,
            "elev": elev_min + index,
            "value": float(year + index),
        }
        for index in range(4)
        if elev_min <= elev_min + index <= elev_max
    ]


def build_loader() -> OperationDataLoader:
    return OperationDataLoader(
        OperationBackendHooks(
            ensure_dataset_loaded=ensure_dataset_loaded,
            validate_variable=validate_variable,
            resolve_elevation_bounds=resolve_elevation_bounds,
            normalize_year_range=normalize_year_range,
            get_subregion=get_subregion,
            query_data=query_data,
        )
    )


class LargeOperationTests(unittest.TestCase):
    def wait_for_job(self, manager: LocalLargeOperationJobManager, job_id: str) -> Dict[str, Any]:
        payload: Dict[str, Any] = {}
        for _ in range(200):
            payload = manager.get_job(job_id)
            if payload["status"] in {"completed", "error", "canceled"}:
                return payload
            time.sleep(0.1)
        self.fail(f"job {job_id} did not finish: {payload}")

    def test_planner_routes_large_date_ranges_to_large_mode(self) -> None:
        loader = build_loader()
        planner = OperationExecutionPlanner(
            loader,
            OperationPlanPolicy(small_date_limit=3, small_estimated_row_limit=10, large_dates_per_chunk=2),
        )
        plan = planner.plan(
            OperationSelection(
                dataset="fake",
                start_date="2000-01-01",
                end_date="2007-01-01",
                variable="temperature",
            )
        )
        self.assertEqual(plan["execution_mode"], "large")
        self.assertEqual(plan["selection"]["date_count"], 8)

    def test_large_job_runs_chunked_aggregate(self) -> None:
        loader = build_loader()
        planner = OperationExecutionPlanner(
            loader,
            OperationPlanPolicy(small_date_limit=3, small_estimated_row_limit=10, large_dates_per_chunk=2),
        )
        selection = OperationSelection(
            dataset="fake",
            start_date="2000-01-01",
            end_date="2007-01-01",
            variable="temperature",
        )
        code = """
def run(hb, meta):
    annual = hb.aggregate(by=["year"], metrics={"value": ["mean", "count"]})
    hb.table(annual, name="annual_mean")
    hb.chart(annual, chart_type="line", x="year", y="value_mean", name="annual_chart")
    hb.export_csv(annual, filename="annual_mean.csv")
"""
        with tempfile.TemporaryDirectory() as tmp:
            manager = LocalLargeOperationJobManager(
                loader=loader,
                planner=planner,
                workspace_root=Path(tmp),
                max_workers=1,
            )
            request = OperationJobCreateRequest(
                code=code,
                selection=selection,
                timeout_seconds=30,
                memory_mb=512,
            )
            job = manager.submit(request, planner.plan(selection))
            payload = self.wait_for_job(manager, job["job_id"])

            self.assertEqual(payload["status"], "completed", payload.get("error"))
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["meta"]["row_count"], 32)
            output_types = [item["type"] for item in payload["outputs"]]
            self.assertIn("table", output_types)
            self.assertIn("chart", output_types)
            self.assertIn("export_file", output_types)

    def test_data_local_job_scans_original_parquet_without_materialization(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source_path = root / "source.parquet"
            frame = pd.DataFrame(
                [
                    {"date": "2000-01-01", "latitude": 30.0, "longitude": 78.0, "elevation_m": 1000.0, "rain": 1.0, "temp": 101.0},
                    {"date": "2000-01-01", "latitude": 31.0, "longitude": 79.0, "elevation_m": 1100.0, "rain": 10.0, "temp": 110.0},
                    {"date": "2000-01-02", "latitude": 30.0, "longitude": 78.0, "elevation_m": 1000.0, "rain": 2.0, "temp": 102.0},
                    {"date": "2000-01-02", "latitude": 31.0, "longitude": 79.0, "elevation_m": 1100.0, "rain": 20.0, "temp": 120.0},
                    {"date": "2001-01-01", "latitude": 30.0, "longitude": 78.0, "elevation_m": 1000.0, "rain": 3.0, "temp": 103.0},
                    {"date": "2001-01-01", "latitude": 31.0, "longitude": 79.0, "elevation_m": 1100.0, "rain": 30.0, "temp": 130.0},
                ]
            )
            frame["date"] = pd.to_datetime(frame["date"])
            frame.to_parquet(source_path, index=False)
            dates = sorted(frame["date"].dt.strftime("%Y-%m-%d").unique().tolist())

            def ensure_local(dataset: Optional[str], year_start: Optional[int] = None, year_end: Optional[int] = None):
                selected = [
                    item for item in dates
                    if (year_start is None or int(item[:4]) >= year_start)
                    and (year_end is None or int(item[:4]) <= year_end)
                ]
                return {
                    "id": dataset or "rain",
                    "label": "Rain test",
                    "storage": "parquet",
                    "path": root,
                    "variables": ["rain", "temp"],
                    "default_variable": "rain",
                    "date_col": "date",
                    "lat_col": "latitude",
                    "lon_col": "longitude",
                    "elev_col": "elevation_m",
                    "date_index": {item: [str(source_path)] for item in selected},
                }

            def get_local_subregion(subregion_id: Optional[str]) -> Optional[Dict[str, Any]]:
                if subregion_id != "cell":
                    return None
                return {
                    "id": "cell",
                    "label": "First grid cell",
                    "bounds": {
                        "min_lat": 29.5,
                        "max_lat": 30.5,
                        "min_lon": 77.5,
                        "max_lon": 78.5,
                    },
                    "polygons": [
                        {
                            "outer": [
                                [77.5, 29.5],
                                [78.5, 29.5],
                                [78.5, 30.5],
                                [77.5, 30.5],
                                [77.5, 29.5],
                            ],
                            "holes": [],
                        }
                    ],
                }

            loader = OperationDataLoader(
                OperationBackendHooks(
                    ensure_dataset_loaded=ensure_local,
                    validate_variable=validate_variable,
                    resolve_elevation_bounds=resolve_elevation_bounds,
                    normalize_year_range=normalize_year_range,
                    get_subregion=get_local_subregion,
                    query_data=query_data,
                )
            )
            planner = OperationExecutionPlanner(
                loader,
                OperationPlanPolicy(small_date_limit=1, small_estimated_row_limit=1, large_dates_per_chunk=1),
            )
            selection = OperationSelection(
                dataset="rain",
                start_date="2000-01-01",
                end_date="2001-01-01",
                variable="rain",
                elev_min=0,
                elev_max=9000,
            )
            code = '''
def run(hb, data, meta):
    annual = hb.sql("""
        WITH annual_pixel AS (
            SELECT year(date)::INTEGER AS year, lat, lon, sum(value) AS annual_total
            FROM data
            GROUP BY year, lat, lon
        )
        SELECT year, avg(annual_total) AS precipitation
        FROM annual_pixel
        GROUP BY year
        ORDER BY year
    """)
    hb.table(annual, name="annual")
    hb.export_query(
        "SELECT year(date)::INTEGER AS year, avg(value) AS mean_value FROM data GROUP BY year ORDER BY year",
        filename="annual.parquet",
        format="parquet",
    )
'''
            manager = LocalLargeOperationJobManager(
                loader=loader,
                planner=planner,
                workspace_root=root / "workspace",
                max_workers=1,
            )
            request = OperationJobCreateRequest(code=code, selection=selection, timeout_seconds=30, memory_mb=512)
            plan = planner.plan(selection)
            job = manager.submit(request, plan)
            payload = self.wait_for_job(manager, job["job_id"])

            self.assertEqual(payload["status"], "completed", payload.get("error"))
            self.assertEqual(payload["engine"], "data_local_duckdb")
            self.assertEqual(payload["meta"]["execution_model"], "data_local_lazy")
            self.assertEqual(payload["progress"]["rows_materialized"], 0)
            self.assertFalse((Path(payload["workspace"]) / "input").exists())
            table = next(item for item in payload["outputs"] if item["type"] == "table")
            self.assertEqual(table["rows"], [[2000, 16.5], [2001, 16.5]])
            export = next(item for item in payload["outputs"] if item["type"] == "export_file")
            self.assertTrue((Path(payload["workspace"]) / "exports" / export["filename"]).exists())

            region_selection = OperationSelection(
                dataset="rain",
                start_date="2000-01-01",
                end_date="2001-01-01",
                variables=["rain", "temp"],
                elev_min=0,
                elev_max=9000,
                subregion_id="cell",
            )
            region_code = '''
def run(hb, data, meta):
    totals = hb.sql("""
        SELECT variable, count(*)::INTEGER AS rows, sum(value) AS total
        FROM data
        GROUP BY variable
        ORDER BY variable
    """)
    hb.table(totals, name="regional_totals")
'''
            region_request = OperationJobCreateRequest(
                code=region_code,
                selection=region_selection,
                timeout_seconds=30,
                memory_mb=512,
            )
            region_job = manager.submit(region_request, planner.plan(region_selection))
            region_payload = self.wait_for_job(manager, region_job["job_id"])
            self.assertEqual(region_payload["status"], "completed", region_payload.get("error"))
            region_table = next(item for item in region_payload["outputs"] if item["type"] == "table")
            self.assertEqual(region_table["rows"], [["rain", 3, 6.0], ["temp", 3, 306.0]])

            mutation_code = '''
def run(hb, data, meta):
    hb.sql("DELETE FROM data")
'''
            mutation_request = OperationJobCreateRequest(
                code=mutation_code,
                selection=selection,
                timeout_seconds=30,
                memory_mb=512,
            )
            mutation_job = manager.submit(mutation_request, planner.plan(selection))
            mutation_payload = self.wait_for_job(manager, mutation_job["job_id"])
            self.assertEqual(mutation_payload["status"], "error")
            self.assertIn("Only one read-only SELECT/WITH statement is allowed", mutation_payload["error"])

            introspection_code = '''
def run(hb, data, meta):
    hb.sql("SELECT current_setting('allowed_paths')")
'''
            introspection_request = OperationJobCreateRequest(
                code=introspection_code,
                selection=selection,
                timeout_seconds=30,
                memory_mb=512,
            )
            introspection_job = manager.submit(introspection_request, planner.plan(selection))
            introspection_payload = self.wait_for_job(manager, introspection_job["job_id"])
            self.assertEqual(introspection_payload["status"], "error")
            self.assertIn("filesystem readers and engine catalogs/settings", introspection_payload["error"])

    def test_large_preflight_rejects_eager_dataframe_code(self) -> None:
        result = validate_large_operation_code(
            """
def run(hb, df, meta):
    copied = df.copy()
    hb.table(copied.groupby("date").mean())
"""
        )
        self.assertFalse(result.ok)
        self.assertIn("too large for eager pandas", result.errors[0]["message"])

    def test_large_preflight_allows_guarded_lazy_code(self) -> None:
        result = validate_large_operation_code(
            """
def run(hb, df, meta):
    if meta.get("large_mode"):
        hb.table(hb.aggregate(by=["year"], metrics={"value": "mean"}))
        return
    hb.table(df.groupby("date").mean())
"""
        )
        self.assertTrue(result.ok, result.errors)

    def test_python_validation_blocks_worker_internal_attributes(self) -> None:
        result = validate_python_code(
            """
def run(hb, data, meta):
    hb._connection.execute("DELETE FROM data")
"""
        )
        self.assertFalse(result.ok)
        self.assertIn("_connection", result.errors[0]["message"])


if __name__ == "__main__":
    unittest.main()
