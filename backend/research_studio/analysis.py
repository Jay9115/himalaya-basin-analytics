from __future__ import annotations

import json
import math
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple

import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from scipy import stats
from scipy.spatial import cKDTree
import statsmodels.api as sm

from .models import ResearchAnalysisRequest


SECTOR_LABELS = {
    "west": "West (<80E)",
    "central": "Central (80-88E)",
    "east": "East (>=88E)",
}


def _finite_or_none(value: Any) -> Any:
    if isinstance(value, (np.floating, float)):
        return float(value) if np.isfinite(value) else None
    if isinstance(value, (np.integer, int)):
        return int(value)
    if isinstance(value, dict):
        return {key: _finite_or_none(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_finite_or_none(item) for item in value]
    return value


def bh_qvalues(p_values: np.ndarray) -> np.ndarray:
    p = np.asarray(p_values, dtype=float)
    q = np.full_like(p, np.nan)
    valid = np.isfinite(p)
    if not np.any(valid):
        return q
    values = p[valid]
    order = np.argsort(values)
    ranked = values[order]
    adjusted = ranked * len(ranked) / np.arange(1, len(ranked) + 1)
    adjusted = np.minimum.accumulate(adjusted[::-1])[::-1]
    adjusted = np.minimum(adjusted, 1.0)
    restored = np.empty_like(adjusted)
    restored[order] = adjusted
    q[valid] = restored
    return q


def weighted_mean(matrix: np.ndarray, weights: np.ndarray) -> np.ndarray:
    valid = np.isfinite(matrix)
    numerator = np.sum(np.where(valid, matrix, 0.0) * weights[None, :], axis=1)
    denominator = np.sum(valid * weights[None, :], axis=1)
    return np.divide(
        numerator,
        denominator,
        out=np.full(matrix.shape[0], np.nan),
        where=denominator > 0,
    )


def weighted_scalar(values: np.ndarray, weights: np.ndarray) -> float:
    values = np.asarray(values, dtype=float)
    valid = np.isfinite(values) & np.isfinite(weights) & (weights > 0)
    if not np.any(valid):
        return float("nan")
    return float(np.average(values[valid], weights=weights[valid]))


def weighted_percent(mask: np.ndarray, valid: np.ndarray, weights: np.ndarray) -> float:
    valid = np.asarray(valid, dtype=bool) & np.isfinite(weights) & (weights > 0)
    if not np.any(valid):
        return float("nan")
    return float(100 * np.average(np.asarray(mask, dtype=float)[valid], weights=weights[valid]))


def theil_sen_pixel_slopes(years: np.ndarray, matrix: np.ndarray) -> np.ndarray:
    pair_count = len(years) * (len(years) - 1) // 2
    pair_slopes = np.empty((pair_count, matrix.shape[1]), dtype=np.float32)
    row = 0
    for earlier in range(len(years) - 1):
        for later in range(earlier + 1, len(years)):
            pair_slopes[row] = (
                (matrix[later] - matrix[earlier]) / float(years[later] - years[earlier])
            ).astype(np.float32)
            row += 1
    with np.errstate(all="ignore"):
        return np.nanmedian(pair_slopes, axis=0).astype(float)


def vectorized_ols(years: np.ndarray, matrix: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    x = years.astype(float)[:, None]
    valid = np.isfinite(matrix)
    n = valid.sum(axis=0).astype(float)
    x_sum = np.sum(np.where(valid, x, 0.0), axis=0)
    y_sum = np.nansum(matrix, axis=0)
    x_mean = np.divide(x_sum, n, out=np.full(matrix.shape[1], np.nan), where=n > 0)
    y_mean = np.divide(y_sum, n, out=np.full(matrix.shape[1], np.nan), where=n > 0)
    dx = np.where(valid, x - x_mean[None, :], 0.0)
    dy = np.where(valid, matrix - y_mean[None, :], 0.0)
    sxx = np.sum(dx * dx, axis=0)
    sxy = np.sum(dx * dy, axis=0)
    slope = np.divide(sxy, sxx, out=np.full(matrix.shape[1], np.nan), where=sxx > 0)
    intercept = y_mean - slope * x_mean
    fitted = intercept[None, :] + slope[None, :] * x
    residual = np.where(valid, matrix - fitted, 0.0)
    dof = n - 2
    mse = np.divide(
        np.sum(residual * residual, axis=0),
        dof,
        out=np.full(matrix.shape[1], np.nan),
        where=dof > 0,
    )
    se = np.sqrt(np.divide(mse, sxx, out=np.full(matrix.shape[1], np.nan), where=sxx > 0))
    t_stat = np.divide(slope, se, out=np.full(matrix.shape[1], np.nan), where=se > 0)
    p_value = 2 * stats.t.sf(np.abs(t_stat), np.maximum(dof, 1))
    p_value[(n < 10) | ~np.isfinite(slope)] = np.nan
    return slope, p_value


def pettitt_pixels(years: np.ndarray, matrix: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    change_year = np.full(matrix.shape[1], np.nan)
    p_value = np.full(matrix.shape[1], np.nan)
    for column in range(matrix.shape[1]):
        values = matrix[:, column]
        valid = np.isfinite(values)
        series = values[valid]
        valid_years = years[valid]
        n = len(series)
        if n < 10:
            continue
        ranks = stats.rankdata(series)
        score = 2 * np.cumsum(ranks) - np.arange(1, n + 1) * (n + 1)
        index = int(np.argmax(np.abs(score[:-1])))
        statistic = abs(float(score[index]))
        change_year[column] = valid_years[index]
        p_value[column] = min(1.0, 2 * np.exp((-6 * statistic**2) / (n**3 + n**2)))
    return change_year, p_value


def persistent_emergence(
    z_values: np.ndarray,
    years: np.ndarray,
    *,
    window: int,
    threshold: float,
    persistence_fraction: float,
) -> np.ndarray:
    full_years = np.arange(int(years.min()), int(years.max()) + 1)
    full = np.full((len(full_years), z_values.shape[1]), np.nan, dtype=float)
    lookup = {int(year): index for index, year in enumerate(full_years)}
    for source_index, year in enumerate(years):
        full[lookup[int(year)]] = z_values[source_index]
    half = window // 2
    smooth = np.full_like(full, np.nan)
    minimum_count = max(window - 1, int(math.ceil(window * 0.80)))
    for index in range(half, len(full_years) - half):
        sample = full[index - half : index + half + 1]
        count = np.isfinite(sample).sum(axis=0)
        smooth[index] = np.divide(
            np.nansum(sample, axis=0),
            count,
            out=np.full(z_values.shape[1], np.nan),
            where=count >= minimum_count,
        )
    terminal_length = min(5, len(full_years))
    terminal = np.nanmean(full[-terminal_length:], axis=0)
    emergence = np.full(z_values.shape[1], np.nan)
    end = len(full_years) - half
    for index in range(half, end):
        future = smooth[index:end]
        valid = np.isfinite(future)
        persistent = np.sum(valid & (future >= 0.5), axis=0) / np.maximum(valid.sum(axis=0), 1)
        selected = (
            np.isnan(emergence)
            & (smooth[index] >= threshold)
            & (persistent >= persistence_fraction)
            & (terminal >= threshold)
        )
        emergence[selected] = full_years[index]
    return emergence


def regional_statistics(years: np.ndarray, values: np.ndarray) -> dict:
    valid = np.isfinite(values)
    x = years[valid].astype(float)
    y = values[valid].astype(float)
    if len(y) < 10:
        return {"n": int(len(y))}
    sen = stats.theilslopes(y, x, alpha=0.95)
    ols = stats.linregress(x, y)
    mk = stats.kendalltau(x, y, nan_policy="omit")
    design = sm.add_constant(x)
    hac = sm.OLS(y, design).fit(cov_type="HAC", cov_kwds={"maxlags": min(3, max(1, len(y) // 10))})
    cp_year, cp_p = pettitt_pixels(x.astype(int), y[:, None])
    return {
        "n": int(len(y)),
        "sen_slope_per_decade": float(sen.slope * 10),
        "sen_ci_low_per_decade": float(sen.low_slope * 10),
        "sen_ci_high_per_decade": float(sen.high_slope * 10),
        "ols_slope_per_decade": float(ols.slope * 10),
        "ols_p": float(ols.pvalue),
        "hac_p": float(hac.pvalues[1]),
        "mann_kendall_tau": float(mk.statistic),
        "mann_kendall_p": float(mk.pvalue),
        "pettitt_year": _finite_or_none(cp_year[0]),
        "pettitt_p": _finite_or_none(cp_p[0]),
    }


class ResearchService:
    def __init__(self, app_root: Path) -> None:
        self.app_root = Path(app_root).resolve()
        self.data_root = self.app_root / "Database" / "Research_Ready"
        self.manifest_path = self.data_root / "manifest.json"
        self.output_root = self.app_root / "Outcomes" / "Research_Studio" / "runs"
        self.output_root.mkdir(parents=True, exist_ok=True)
        self._manifest: Optional[dict] = None
        self._lock = threading.Lock()

    def manifest(self) -> dict:
        if self._manifest is None:
            if not self.manifest_path.exists():
                raise FileNotFoundError(
                    "Research-ready data are missing. Run backend/research_studio/prepare_research_ready_data.py."
                )
            self._manifest = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        return self._manifest

    def capabilities(self) -> dict:
        manifest = self.manifest()
        return {
            **manifest,
            "methods": [
                {"id": "trend", "label": "Theil–Sen trend + HAC/Mann–Kendall inference"},
                {"id": "anomaly", "label": "Pixel-standardized baseline anomalies"},
                {"id": "emergence", "label": "Persistent signal-to-noise time of emergence"},
                {"id": "change_point", "label": "Pettitt median shift + Benjamini–Hochberg FDR"},
                {"id": "compound", "label": "Compound positive/negative anomaly footprint"},
            ],
            "figure_types": [
                {"id": "diagnostic_atlas", "label": "Four-panel research diagnostic atlas", "requires_run": True},
                {"id": "timeseries", "label": "Publication anomaly chronicle", "requires_run": True},
                {"id": "study_region", "label": "Study region and analysis units", "requires_run": False},
                {"id": "elevation", "label": "Elevation and glacier context", "requires_run": False},
            ],
            "guardrail": "Statistical association and emergence do not establish causal attribution.",
        }

    def dataset_meta(self, dataset_id: str) -> dict:
        dataset = next((item for item in self.manifest().get("datasets", []) if item["id"] == dataset_id), None)
        if not dataset:
            raise ValueError(f"Unknown research dataset: {dataset_id}")
        return dataset

    def _read_frame(self, request: ResearchAnalysisRequest, variables: Iterable[str]) -> pd.DataFrame:
        dataset = self.dataset_meta(request.dataset)
        available = dataset.get("variables", {})
        selected = list(dict.fromkeys(variables))
        unknown = [variable for variable in selected if variable not in available]
        if unknown:
            raise ValueError(f"Variable(s) unavailable for {request.dataset}: {', '.join(unknown)}")
        filters: list[tuple[str, str, Any]] = [
            ("year", ">=", request.year_start),
            ("year", "<=", request.year_end),
            ("elevation_m", ">=", request.elev_min),
            ("elevation_m", "<=", request.elev_max),
        ]
        if request.sector != "all":
            filters.append(("sector", "==", SECTOR_LABELS[request.sector]))
        if request.basin is not None:
            filters.append(("basin", "==", request.basin))
        columns = [
            "year",
            "pixel_id",
            "latitude",
            "longitude",
            "elevation_m",
            "basin",
            "sector",
            "elevation_band",
            "coslat_weight",
            *selected,
        ]
        path = self.data_root / dataset["path"]
        table = pq.read_table(path, columns=columns, filters=filters)
        frame = table.to_pandas()
        if frame.empty:
            raise ValueError("No annual research data match the requested period and spatial filters.")
        return frame

    def analyze(self, request: ResearchAnalysisRequest) -> dict:
        secondary_dataset_id = request.secondary_dataset or request.dataset
        requested_variables = [request.variable]
        if request.secondary_variable and secondary_dataset_id == request.dataset:
            requested_variables.append(request.secondary_variable)
        frame = self._read_frame(request, requested_variables)
        years = np.sort(frame["year"].unique()).astype(int)
        baseline_years = years[(years >= request.baseline_start) & (years <= request.baseline_end)]
        if len(baseline_years) < 10:
            raise ValueError("The selected baseline contains fewer than 10 available years.")

        meta = (
            frame.drop_duplicates("pixel_id")
            .set_index("pixel_id")
            .sort_index()[
                ["latitude", "longitude", "elevation_m", "basin", "sector", "elevation_band", "coslat_weight"]
            ]
        )
        pixel_ids = meta.index.to_numpy()
        primary = (
            frame.pivot(index="year", columns="pixel_id", values=request.variable)
            .reindex(index=years, columns=pixel_ids)
            .to_numpy(float)
        )
        direction = 1.0 if request.signal_direction == "positive" else -1.0
        baseline_mask = np.isin(years, baseline_years)
        baseline_mean = np.nanmean(primary[baseline_mask], axis=0)
        baseline_sd = np.nanstd(primary[baseline_mask], axis=0, ddof=1)
        primary_z = np.divide(
            primary - baseline_mean[None, :],
            baseline_sd[None, :],
            out=np.full_like(primary, np.nan),
            where=baseline_sd[None, :] > 0,
        ) * direction
        weights = meta["coslat_weight"].to_numpy(float)
        regional_raw = weighted_mean(primary, weights)
        regional_z = weighted_mean(primary_z, weights)
        footprint = np.array([
            weighted_percent(row >= request.anomaly_threshold, np.isfinite(row), weights)
            for row in primary_z
        ])

        secondary = None
        secondary_z = None
        secondary_raw = np.full(len(years), np.nan)
        compound = np.full(len(years), np.nan)
        harmonization = None
        if request.secondary_variable:
            if secondary_dataset_id == request.dataset:
                secondary = (
                    frame.pivot(index="year", columns="pixel_id", values=request.secondary_variable)
                    .reindex(index=years, columns=pixel_ids)
                    .to_numpy(float)
                )
                harmonization = "Shared native analysis grid"
            else:
                secondary_request = request.model_copy(
                    update={
                        "dataset": secondary_dataset_id,
                        "variable": request.secondary_variable,
                        "secondary_dataset": None,
                        "secondary_variable": None,
                    }
                )
                secondary_frame = self._read_frame(secondary_request, [request.secondary_variable])
                secondary_meta = (
                    secondary_frame.drop_duplicates("pixel_id")
                    .set_index("pixel_id")
                    .sort_index()[["latitude", "longitude"]]
                )
                secondary_pixels = secondary_meta.index.to_numpy()
                secondary_native = (
                    secondary_frame.pivot(index="year", columns="pixel_id", values=request.secondary_variable)
                    .reindex(index=years, columns=secondary_pixels)
                    .to_numpy(float)
                )
                longitude_scale = float(np.cos(np.deg2rad(meta["latitude"].mean())))
                source_xy = np.column_stack(
                    [
                        secondary_meta["latitude"].to_numpy(float),
                        secondary_meta["longitude"].to_numpy(float) * longitude_scale,
                    ]
                )
                target_xy = np.column_stack(
                    [
                        meta["latitude"].to_numpy(float),
                        meta["longitude"].to_numpy(float) * longitude_scale,
                    ]
                )
                distances, nearest = cKDTree(source_xy).query(target_xy, k=1)
                secondary = secondary_native[:, nearest]
                harmonization = (
                    f"{secondary_dataset_id} sampled to the {request.dataset} analysis grid by "
                    f"nearest cell (median offset {np.nanmedian(distances):.3f}°; maximum {np.nanmax(distances):.3f}°)"
                )
            secondary_direction = 1.0 if request.secondary_direction == "positive" else -1.0
            secondary_mean = np.nanmean(secondary[baseline_mask], axis=0)
            secondary_sd = np.nanstd(secondary[baseline_mask], axis=0, ddof=1)
            secondary_z = np.divide(
                secondary - secondary_mean[None, :],
                secondary_sd[None, :],
                out=np.full_like(secondary, np.nan),
                where=secondary_sd[None, :] > 0,
            ) * secondary_direction
            secondary_raw = weighted_mean(secondary, weights)
            for index in range(len(years)):
                overlap = (primary_z[index] >= request.anomaly_threshold) & (
                    secondary_z[index] >= request.anomaly_threshold
                )
                valid_overlap = np.isfinite(primary_z[index]) & np.isfinite(secondary_z[index])
                compound[index] = weighted_percent(overlap, valid_overlap, weights)

        recent_start = request.recent_start or max(request.year_start, request.year_end - 14)
        recent_mask = (years >= recent_start) & (years <= request.year_end)
        recent_anomaly = np.nanmean(primary_z[recent_mask], axis=0)
        sen_slope = theil_sen_pixel_slopes(years, primary) * 10
        _, spatial_p = vectorized_ols(years, primary)
        spatial_q = bh_qvalues(spatial_p)
        emergence = persistent_emergence(
            primary_z,
            years,
            window=request.emergence_window,
            threshold=request.emergence_threshold,
            persistence_fraction=request.persistence_fraction,
        )
        change_year, change_p = pettitt_pixels(years, primary)
        change_q = bh_qvalues(change_p)

        annual_rows = []
        regional_baseline_mean = float(np.nanmean(regional_raw[baseline_mask]))
        for index, year in enumerate(years):
            annual_rows.append(
                {
                    "year": int(year),
                    "value": _finite_or_none(regional_raw[index]),
                    "anomaly": _finite_or_none(regional_raw[index] - regional_baseline_mean),
                    "z_mean": _finite_or_none(regional_z[index]),
                    "signal_area_percent": _finite_or_none(footprint[index]),
                    "secondary_value": _finite_or_none(secondary_raw[index]),
                    "compound_area_percent": _finite_or_none(compound[index]),
                }
            )

        pixel_metrics = meta.reset_index().copy()
        pixel_metrics["trend_per_decade"] = sen_slope
        pixel_metrics["trend_p_ols"] = spatial_p
        pixel_metrics["trend_q_fdr"] = spatial_q
        pixel_metrics["recent_anomaly_z"] = recent_anomaly
        pixel_metrics["emergence_year"] = emergence
        pixel_metrics["change_year"] = change_year
        pixel_metrics["change_p"] = change_p
        pixel_metrics["change_q_fdr"] = change_q

        group_summary = self._group_summary(pixel_metrics, weights)
        trend_stats = regional_statistics(years, regional_raw)
        significant_trend_area = weighted_percent(spatial_q < 0.05, np.isfinite(spatial_q), weights)
        significant_change_area = weighted_percent(change_q < 0.05, np.isfinite(change_q), weights)
        emerged_area = weighted_percent(np.isfinite(emergence), np.ones(len(emergence), dtype=bool), weights)
        headline = {
            "regional_sen_slope_per_decade": trend_stats.get("sen_slope_per_decade"),
            "regional_hac_p": trend_stats.get("hac_p"),
            "spatial_fdr_trend_area_percent": float(significant_trend_area),
            "persistent_emerged_area_percent": float(emerged_area),
            "median_emergence_year": _finite_or_none(np.nanmedian(emergence)) if np.any(np.isfinite(emergence)) else None,
            "pettitt_fdr_area_percent": float(significant_change_area),
            "median_fdr_change_year": _finite_or_none(np.nanmedian(change_year[change_q < 0.05]))
            if np.any(change_q < 0.05)
            else None,
            "recent_mean_anomaly_z": weighted_scalar(recent_anomaly, weights),
            "largest_signal_year": int(years[int(np.nanargmax(footprint))]),
            "largest_signal_area_percent": float(np.nanmax(footprint)),
        }
        if request.secondary_variable and np.any(np.isfinite(compound)):
            headline["largest_compound_year"] = int(years[int(np.nanargmax(compound))])
            headline["largest_compound_area_percent"] = float(np.nanmax(compound))

        run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
        run_dir = self.output_root / run_id
        with self._lock:
            run_dir.mkdir(parents=True, exist_ok=False)
            pd.DataFrame(annual_rows).to_csv(run_dir / "annual_series.csv", index=False)
            pixel_metrics.to_parquet(run_dir / "pixel_metrics.parquet", index=False, compression="zstd")
            (run_dir / "request.json").write_text(request.model_dump_json(indent=2), encoding="utf-8")

        dataset = self.dataset_meta(request.dataset)
        secondary_dataset = self.dataset_meta(secondary_dataset_id) if request.secondary_variable else None
        variable_meta = dataset["variables"][request.variable]
        result = {
            "run_id": run_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "selection": request.model_dump(),
            "dataset": {"id": dataset["id"], "label": dataset["label"]},
            "variable": {"id": request.variable, **variable_meta},
            "secondary_variable": (
                {
                    "id": request.secondary_variable,
                    "dataset_id": secondary_dataset_id,
                    "dataset_label": secondary_dataset["label"],
                    **secondary_dataset["variables"][request.secondary_variable],
                }
                if request.secondary_variable
                else None
            ),
            "harmonization": harmonization,
            "coverage": {
                "available_years": years.tolist(),
                "year_count": int(len(years)),
                "baseline_years": baseline_years.tolist(),
                "pixel_count": int(len(meta)),
                "recent_period": [int(recent_start), int(request.year_end)],
            },
            "headline": headline,
            "regional_statistics": trend_stats,
            "annual_series": annual_rows,
            "group_summary": group_summary,
            "layers": [
                self._layer("trend", f"Theil–Sen trend ({variable_meta['unit']} decade⁻¹)", pixel_metrics, "trend_per_decade", request.max_map_points, significant="trend_q_fdr"),
                self._layer("anomaly", f"Recent anomaly ({recent_start}–{request.year_end}; baseline SD)", pixel_metrics, "recent_anomaly_z", request.max_map_points),
                self._layer("emergence", "Persistent signal emergence year", pixel_metrics, "emergence_year", request.max_map_points, sequential=True),
                self._layer("change_point", "FDR-significant median-shift year", pixel_metrics.loc[pixel_metrics["change_q_fdr"] < 0.05], "change_year", request.max_map_points, sequential=True),
            ],
            "caveats": dataset.get("caveats", []),
            "interpretation_guardrails": [
                "Time of emergence identifies statistical detectability, not the physical origin of climate change.",
                "Pettitt dates identify one candidate median shift; they are not causal break dates.",
                "FDR controls multiplicity but does not remove product, spatial-dependence, or model uncertainty.",
                "Environmental co-variation and compound anomalies do not establish causal attribution.",
            ],
            "exports": {
                "annual_csv": f"/research/runs/{run_id}/annual_series.csv",
                "pixel_parquet": f"/research/runs/{run_id}/pixel_metrics.parquet",
                "summary_json": f"/research/runs/{run_id}/summary.json",
            },
        }
        clean_result = _finite_or_none(result)
        (run_dir / "summary.json").write_text(json.dumps(clean_result, indent=2), encoding="utf-8")
        return clean_result

    def _layer(
        self,
        layer_id: str,
        label: str,
        frame: pd.DataFrame,
        value_column: str,
        max_points: int,
        *,
        significant: Optional[str] = None,
        sequential: bool = False,
    ) -> dict:
        subset = frame[np.isfinite(frame[value_column])].copy()
        if len(subset) > max_points:
            # Spatially stable systematic thinning retains the full domain and
            # avoids random map changes between identical runs.
            positions = np.linspace(0, len(subset) - 1, max_points, dtype=int)
            subset = subset.iloc[positions]
        records = []
        for row in subset.itertuples(index=False):
            record = {
                "lat": float(row.latitude),
                "lon": float(row.longitude),
                "value": float(getattr(row, value_column)),
                "elev": float(row.elevation_m),
                "basin": int(row.basin),
            }
            if significant:
                q_value = getattr(row, significant)
                record["significant"] = bool(np.isfinite(q_value) and q_value < 0.05)
            records.append(record)
        values = subset[value_column].to_numpy(float)
        return {
            "id": layer_id,
            "label": label,
            "sequential": sequential,
            "point_count": int(len(records)),
            "min": _finite_or_none(np.nanmin(values)) if len(values) else None,
            "max": _finite_or_none(np.nanmax(values)) if len(values) else None,
            "data": records,
        }

    def _group_summary(self, frame: pd.DataFrame, all_weights: np.ndarray) -> list[dict]:
        rows = []
        group_specs = [("Selected domain", np.ones(len(frame), dtype=bool))]
        for band in ["<1500 m", "1500-2999 m", "3000-4499 m", ">=4500 m"]:
            mask = frame["elevation_band"].to_numpy() == band
            if np.any(mask):
                group_specs.append((band, mask))
        for sector in ["West (<80E)", "Central (80-88E)", "East (>=88E)"]:
            mask = frame["sector"].to_numpy() == sector
            if np.any(mask):
                group_specs.append((sector, mask))
        for label, mask in group_specs:
            weights = all_weights[mask]
            emerged = np.isfinite(frame.loc[mask, "emergence_year"].to_numpy(float))
            cp_q = frame.loc[mask, "change_q_fdr"].to_numpy(float)
            trend_q = frame.loc[mask, "trend_q_fdr"].to_numpy(float)
            rows.append(
                {
                    "group": label,
                    "pixels": int(mask.sum()),
                    "mean_trend_per_decade": weighted_scalar(frame.loc[mask, "trend_per_decade"].to_numpy(float), weights),
                    "trend_fdr_area_percent": weighted_percent(trend_q < 0.05, np.isfinite(trend_q), weights),
                    "emerged_area_percent": weighted_percent(emerged, np.ones(len(emerged), dtype=bool), weights),
                    "median_emergence_year": _finite_or_none(np.nanmedian(frame.loc[mask, "emergence_year"]))
                    if np.any(emerged)
                    else None,
                    "change_fdr_area_percent": weighted_percent(cp_q < 0.05, np.isfinite(cp_q), weights),
                    "recent_anomaly_z": weighted_scalar(frame.loc[mask, "recent_anomaly_z"].to_numpy(float), weights),
                }
            )
        return _finite_or_none(rows)

    def run_dir(self, run_id: str) -> Path:
        if not run_id or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for character in run_id):
            raise ValueError("Invalid research run id")
        path = (self.output_root / run_id).resolve()
        if self.output_root not in path.parents or not path.is_dir():
            raise FileNotFoundError("Research run not found")
        return path
