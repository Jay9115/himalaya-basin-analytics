import json
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

import pandas as pd
from fastapi import HTTPException

from .schemas import OperationSelection


def _parse_date(value: Optional[str], field_name: str) -> Optional[str]:
    if value is None:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"{field_name} must use YYYY-MM-DD format") from exc


def _unique_preserve_order(values: List[str]) -> List[str]:
    seen = set()
    output = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        output.append(value)
    return output


@dataclass
class OperationBackendHooks:
    ensure_dataset_loaded: Callable[..., Dict[str, Any]]
    validate_variable: Callable[[Dict[str, Any], Optional[str]], str]
    resolve_elevation_bounds: Callable[[Dict[str, Any], Optional[float], Optional[float]], Tuple[float, float]]
    normalize_year_range: Callable[[Optional[int], Optional[int]], Tuple[Optional[int], Optional[int]]]
    get_subregion: Callable[[Optional[str]], Optional[Dict[str, Any]]]
    query_data: Callable[..., List[Dict[str, Any]]]


@dataclass
class ResolvedOperationSelection:
    state: Dict[str, Any]
    variables: List[str]
    dates: List[str]
    elev_min: float
    elev_max: float
    subregion: Optional[Dict[str, Any]]
    requested_dates: Optional[List[str]]
    start_date: Optional[str]
    end_date: Optional[str]
    year_start: Optional[int]
    year_end: Optional[int]

    def base_meta(self) -> Dict[str, Any]:
        return {
            "dataset": self.state["id"],
            "dataset_label": self.state["label"],
            "storage": self.state.get("storage", "parquet"),
            "variables": self.variables,
            "date_count": len(self.dates),
            "dates": self.dates,
            "date_start": self.dates[0] if self.dates else None,
            "date_end": self.dates[-1] if self.dates else None,
            "elev_min": self.elev_min,
            "elev_max": self.elev_max,
            "subregion_id": self.subregion["id"] if self.subregion else None,
            "subregion_label": self.subregion["label"] if self.subregion else None,
        }


class OperationDataLoader:
    def __init__(self, hooks: OperationBackendHooks) -> None:
        self.hooks = hooks

    def load_selection(self, selection: OperationSelection) -> Tuple[pd.DataFrame, Dict[str, Any]]:
        resolved = self.resolve_selection(selection)

        if not resolved.dates:
            raise HTTPException(
                status_code=404,
                detail="No indexed data exists for the requested date selection.",
            )

        records: List[Dict[str, Any]] = []
        truncated = False
        max_rows = int(selection.max_rows) if selection.max_rows is not None else None
        for date_key in resolved.dates:
            for variable in resolved.variables:
                rows = self.hooks.query_data(
                    resolved.state,
                    date_key,
                    resolved.elev_min,
                    resolved.elev_max,
                    variable,
                    subregion=resolved.subregion,
                )
                for row in rows:
                    if max_rows is not None and len(records) >= max_rows:
                        truncated = True
                        break
                    normalized = dict(row)
                    normalized["dataset"] = resolved.state["id"]
                    resolved = self.resolve_selection(selection)
                    normalized["date"] = date_key
                    normalized["variable"] = variable
                    normalized["value"] = normalized.get("value")
                    normalized[variable] = normalized.get("value")
                    records.append(normalized)
                if truncated:
                    break
            if truncated:
                break

        frame = self._records_to_frame(records, resolved.variables)
        meta = {
            **resolved.base_meta(),
            "row_count": int(len(frame)),
            "truncated": truncated,
            "max_rows": max_rows,
            "columns": list(frame.columns),
        }
        return frame, meta

    def resolve_selection(self, selection: OperationSelection) -> ResolvedOperationSelection:
        requested_dates = self._requested_dates(selection)
        start_date, end_date = self._date_bounds(selection, requested_dates)
        year_start, year_end = self._index_years(selection, start_date, end_date)

        state = self.hooks.ensure_dataset_loaded(
            selection.dataset,
            year_start=year_start,
            year_end=year_end,
        )
        variables = self._resolve_variables(state, selection)
        elev_min, elev_max = self.hooks.resolve_elevation_bounds(state, selection.elev_min, selection.elev_max)
        subregion = self.hooks.get_subregion(selection.subregion_id)

        available_dates = sorted(state["date_index"].keys())
        dates = self._select_available_dates(
            available_dates=available_dates,
            requested_dates=requested_dates,
            start_date=start_date,
            end_date=end_date,
            max_dates=selection.max_dates,
        )

        return ResolvedOperationSelection(
            state=state,
            variables=variables,
            dates=dates,
            elev_min=elev_min,
            elev_max=elev_max,
            subregion=subregion,
            requested_dates=requested_dates,
            start_date=start_date,
            end_date=end_date,
            year_start=year_start,
            year_end=year_end,
        )

    def iter_selection_frames(
        self,
        selection: OperationSelection,
        *,
        dates_per_chunk: int = 30,
    ) -> Iterator[Tuple[pd.DataFrame, Dict[str, Any]]]:
        resolved = self.resolve_selection(selection)
        if not resolved.dates:
            raise HTTPException(
                status_code=404,
                detail="No indexed data exists for the requested date selection.",
            )

        chunk_size = max(1, int(dates_per_chunk or 1))
        for chunk_index, start in enumerate(range(0, len(resolved.dates), chunk_size)):
            chunk_dates = resolved.dates[start:start + chunk_size]
            records: List[Dict[str, Any]] = []
            for date_key in chunk_dates:
                for variable in resolved.variables:
                    rows = self.hooks.query_data(
                        resolved.state,
                        date_key,
                        resolved.elev_min,
                        resolved.elev_max,
                        variable,
                        subregion=resolved.subregion,
                    )
                    for row in rows:
                        normalized = dict(row)
                        normalized["dataset"] = resolved.state["id"]
                        normalized["date"] = date_key
                        normalized["variable"] = variable
                        normalized["value"] = normalized.get("value")
                        normalized[variable] = normalized.get("value")
                        records.append(normalized)

            frame = self._records_to_frame(records, resolved.variables)
            meta = {
                **resolved.base_meta(),
                "chunk_index": chunk_index,
                "chunk_date_start": chunk_dates[0],
                "chunk_date_end": chunk_dates[-1],
                "chunk_date_count": len(chunk_dates),
                "chunk_row_count": int(len(frame)),
                "columns": list(frame.columns),
            }
            yield frame, meta

    def _requested_dates(self, selection: OperationSelection) -> Optional[List[str]]:
        if not selection.dates:
            single_date = _parse_date(selection.date, "date")
            return [single_date] if single_date else None

        if selection.max_dates is not None and len(selection.dates) > selection.max_dates:
            raise HTTPException(
                status_code=400,
                detail=f"Too many requested dates. Limit is {selection.max_dates}.",
            )
        parsed = [_parse_date(value, "dates") for value in selection.dates]
        return _unique_preserve_order([value for value in parsed if value])

    def _date_bounds(
        self,
        selection: OperationSelection,
        requested_dates: Optional[List[str]],
    ) -> Tuple[Optional[str], Optional[str]]:
        if requested_dates:
            return min(requested_dates), max(requested_dates)

        start_date = _parse_date(selection.start_date, "start_date")
        end_date = _parse_date(selection.end_date, "end_date")

        if start_date and not end_date:
            end_date = start_date
        if end_date and not start_date:
            start_date = end_date
        if start_date and end_date and start_date > end_date:
            raise HTTPException(status_code=400, detail="start_date cannot be after end_date")
        return start_date, end_date

    def _index_years(
        self,
        selection: OperationSelection,
        start_date: Optional[str],
        end_date: Optional[str],
    ) -> Tuple[Optional[int], Optional[int]]:
        year_start = selection.year_start
        year_end = selection.year_end
        if year_start is None and start_date:
            year_start = int(start_date[:4])
        if year_end is None and end_date:
            year_end = int(end_date[:4])
        return self.hooks.normalize_year_range(year_start, year_end)

    def _resolve_variables(self, state: Dict[str, Any], selection: OperationSelection) -> List[str]:
        requested: List[Optional[str]] = []
        if selection.variable:
            requested.append(selection.variable)
        if selection.variables:
            requested.extend(selection.variables)
        if not requested:
            requested.append(None)

        if len(requested) > 8:
            raise HTTPException(status_code=400, detail="At most 8 variables can be selected per operation.")

        variables = [self.hooks.validate_variable(state, variable) for variable in requested]
        return _unique_preserve_order(variables)

    def _select_available_dates(
        self,
        *,
        available_dates: List[str],
        requested_dates: Optional[List[str]],
        start_date: Optional[str],
        end_date: Optional[str],
        max_dates: Optional[int],
    ) -> List[str]:
        if requested_dates:
            available = set(available_dates)
            dates = [date_key for date_key in requested_dates if date_key in available]
        elif start_date and end_date:
            dates = [date_key for date_key in available_dates if start_date <= date_key <= end_date]
        else:
            # Keep Monaco experiments quick by defaulting to the latest indexed date.
            dates = available_dates[-1:] if available_dates else []

        if max_dates is not None and len(dates) > max_dates:
            raise HTTPException(
                status_code=400,
                detail=f"Date selection contains {len(dates)} dates. Limit is {max_dates}.",
            )
        return dates

    def _records_to_frame(self, records: List[Dict[str, Any]], variables: List[str]) -> pd.DataFrame:
        base_columns = ["dataset", "date", "lat", "lon", "elev", "variable", "value"]
        if not records:
            return pd.DataFrame(columns=base_columns + variables)

        frame = pd.DataFrame.from_records(records)
        for column in base_columns:
            if column not in frame.columns:
                frame[column] = None
        for column in ["lat", "lon", "elev", "value"]:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")

        ordered = base_columns + [column for column in variables if column in frame.columns]
        extras = [column for column in frame.columns if column not in ordered]
        return frame[ordered + extras]


def dataframe_to_worker_payload(frame: pd.DataFrame) -> Dict[str, Any]:
    # pandas writes NaN/NaT as JSON null here, which keeps the worker payload clean.
    return json.loads(frame.to_json(orient="split", date_format="iso"))
