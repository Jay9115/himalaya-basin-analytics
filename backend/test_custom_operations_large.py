import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from custom_operations.data_access import OperationBackendHooks, OperationDataLoader
from custom_operations.large_jobs import LocalLargeOperationJobManager
from custom_operations.planner import OperationExecutionPlanner, OperationPlanPolicy
from custom_operations.schemas import OperationJobCreateRequest, OperationSelection


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
            for _ in range(80):
                payload = manager.get_job(job["job_id"])
                if payload["status"] in {"completed", "error", "canceled"}:
                    break
                time.sleep(0.1)

            self.assertEqual(payload["status"], "completed", payload.get("error"))
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["meta"]["row_count"], 32)
            output_types = [item["type"] for item in payload["outputs"]]
            self.assertIn("table", output_types)
            self.assertIn("chart", output_types)
            self.assertIn("export_file", output_types)


if __name__ == "__main__":
    unittest.main()
