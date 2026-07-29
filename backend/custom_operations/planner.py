from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from .data_access import OperationDataLoader
from .schemas import OperationSelection


@dataclass
class OperationPlanPolicy:
    small_date_limit: int = 366
    small_estimated_row_limit: int = 250_000
    sample_date_limit: int = 3
    large_dates_per_chunk: int = 30


class OperationExecutionPlanner:
    def __init__(self, loader: OperationDataLoader, policy: Optional[OperationPlanPolicy] = None) -> None:
        self.loader = loader
        self.policy = policy or OperationPlanPolicy()

    def plan(self, selection: OperationSelection) -> Dict[str, Any]:
        resolved = self.loader.resolve_selection(selection)
        sample = self._sample_row_counts(resolved)
        estimated_rows = self._estimate_total_rows(
            date_count=len(resolved.dates),
            variable_count=len(resolved.variables),
            sample_row_counts=sample["row_counts"],
        )
        reasons: List[str] = []

        if len(resolved.dates) > self.policy.small_date_limit:
            reasons.append(
                f"date_count {len(resolved.dates)} exceeds interactive limit {self.policy.small_date_limit}"
            )
        if estimated_rows is not None and estimated_rows > self.policy.small_estimated_row_limit:
            reasons.append(
                f"estimated_rows {estimated_rows} exceeds interactive limit {self.policy.small_estimated_row_limit}"
            )

        execution_mode = "large" if reasons else "interactive"
        return {
            "ok": True,
            "execution_mode": execution_mode,
            "can_run_inline": execution_mode == "interactive",
            "reasons": reasons,
            "policy": {
                "small_date_limit": self.policy.small_date_limit,
                "small_estimated_row_limit": self.policy.small_estimated_row_limit,
                "large_dates_per_chunk": self.policy.large_dates_per_chunk,
            },
            "selection": {
                "dataset": resolved.state["id"],
                "dataset_label": resolved.state["label"],
                "storage": resolved.state.get("storage", "parquet"),
                "variables": resolved.variables,
                "variable_count": len(resolved.variables),
                "date_count": len(resolved.dates),
                "date_start": resolved.dates[0] if resolved.dates else None,
                "date_end": resolved.dates[-1] if resolved.dates else None,
                "elev_min": resolved.elev_min,
                "elev_max": resolved.elev_max,
                "subregion_id": resolved.subregion["id"] if resolved.subregion else None,
                "subregion_label": resolved.subregion["label"] if resolved.subregion else None,
            },
            "estimate": {
                "estimated_rows": estimated_rows,
                "sampled_dates": sample["sampled_dates"],
                "sampled_rows": sample["sampled_rows"],
                "average_rows_per_date_variable": sample["average_rows_per_date_variable"],
            },
        }

    def _sample_row_counts(self, resolved: Any) -> Dict[str, Any]:
        sampled_dates = resolved.dates[: self.policy.sample_date_limit]
        row_counts: List[int] = []
        sampled_rows = 0
        for date_key in sampled_dates:
            for variable in resolved.variables:
                rows = self.loader.hooks.query_data(
                    resolved.state,
                    date_key,
                    resolved.elev_min,
                    resolved.elev_max,
                    variable,
                    subregion=resolved.subregion,
                )
                row_count = len(rows)
                row_counts.append(row_count)
                sampled_rows += row_count

        average = None
        if row_counts:
            average = sampled_rows / len(row_counts)
        return {
            "sampled_dates": sampled_dates,
            "sampled_rows": sampled_rows,
            "row_counts": row_counts,
            "average_rows_per_date_variable": average,
        }

    def _estimate_total_rows(
        self,
        *,
        date_count: int,
        variable_count: int,
        sample_row_counts: List[int],
    ) -> Optional[int]:
        if not sample_row_counts:
            return 0
        average = sum(sample_row_counts) / len(sample_row_counts)
        return int(round(average * date_count * variable_count))
