from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional

import numpy as np
import pandas as pd
from scipy import stats
from scipy.spatial import cKDTree
from fastapi import HTTPException

from custom_operations.data_access import OperationDataLoader
from custom_operations.schemas import OperationSelection

from .analysis import (
    _finite_or_none,
    bh_qvalues,
    persistent_emergence,
    pettitt_pixels,
    regional_statistics,
    theil_sen_pixel_slopes,
    vectorized_ols,
    weighted_mean,
    weighted_percent,
    weighted_scalar,
)
from .framework_models import ResearchFrameworkRequest, ResearchVariableSpec


AGGREGATIONS = {
    "mean": "AVG",
    "sum": "SUM",
    "min": "MIN",
    "max": "MAX",
    "median": "MEDIAN",
}


def _quote_identifier(value: str) -> str:
    return '"' + str(value).replace('"', '""') + '"'


def _quote_literal(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _pretty_label(value: str) -> str:
    return str(value).replace("_", " ").replace("-", " ").strip().title()


def _safe_key(index: int, spec: ResearchVariableSpec) -> str:
    return f"v{index + 1}_{spec.dataset}_{spec.variable}".replace(" ", "_")


def _aoi_to_polygons(geometry: Dict[str, Any]) -> list[dict]:
    if not isinstance(geometry, dict):
        return []
    coordinates = geometry.get("coordinates")
    if geometry.get("type") == "Polygon":
        polygon_sets = [coordinates]
    elif geometry.get("type") == "MultiPolygon":
        polygon_sets = coordinates
    else:
        return []
    polygons = []
    for polygon in polygon_sets or []:
        if not polygon:
            continue
        outer = np.asarray(polygon[0], dtype=float)
        if outer.ndim != 2 or outer.shape[0] < 4 or outer.shape[1] < 2:
            continue
        holes = []
        for hole in polygon[1:] or []:
            hole_array = np.asarray(hole, dtype=float)
            if hole_array.ndim == 2 and hole_array.shape[0] >= 4 and hole_array.shape[1] >= 2:
                holes.append(hole_array[:, :2])
        polygons.append({"outer": outer[:, :2], "holes": holes})
    return polygons


def _polygon_bounds(polygons: Iterable[dict]) -> Optional[Dict[str, float]]:
    parts = list(polygons)
    if not parts:
        return None
    return {
        "min_lon": min(float(np.min(part["outer"][:, 0])) for part in parts),
        "max_lon": max(float(np.max(part["outer"][:, 0])) for part in parts),
        "min_lat": min(float(np.min(part["outer"][:, 1])) for part in parts),
        "max_lat": max(float(np.max(part["outer"][:, 1])) for part in parts),
    }


@dataclass
class DataCube:
    key: str
    spec: ResearchVariableSpec
    dataset_label: str
    years: np.ndarray
    meta: pd.DataFrame
    matrix: np.ndarray
    source_rows: int

    @property
    def weights(self) -> np.ndarray:
        return np.cos(np.deg2rad(self.meta["latitude"].to_numpy(float))).clip(0.05, None)


class ResearchFrameworkService:
    """General guided-research engine backed by the dashboard's data contract.

    The service never writes into source dataset directories. It resolves the
    same indexed selection used by the dashboard, performs annual aggregation
    in memory, and writes only derived artifacts under Outcomes.
    """

    def __init__(self, app_root: Path, loader: OperationDataLoader) -> None:
        self.app_root = Path(app_root).resolve()
        self.loader = loader
        self.output_root = self.app_root / "Outcomes" / "Research_Framework" / "runs"
        self.output_root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    @staticmethod
    def capabilities() -> dict:
        return {
            "mode": "selection-aware-general-framework",
            "max_variables": 4,
            "aggregations": [
                {"id": "mean", "label": "Annual mean"},
                {"id": "sum", "label": "Annual sum"},
                {"id": "min", "label": "Annual minimum"},
                {"id": "max", "label": "Annual maximum"},
                {"id": "median", "label": "Annual median"},
            ],
            "methods": [
                {"id": "descriptive", "label": "Coverage and distribution diagnostics"},
                {"id": "trend", "label": "Theil–Sen trend + HAC/Mann–Kendall inference"},
                {"id": "anomaly", "label": "Baseline-standardized anomalies"},
                {"id": "emergence", "label": "Persistent signal-to-noise time of emergence"},
                {"id": "change_point", "label": "Pettitt shift + Benjamini–Hochberg FDR"},
                {"id": "relationships", "label": "Regional, lagged, spatial, and local relationships"},
                {"id": "compound", "label": "Joint standardized anomaly footprint"},
            ],
            "figure_types": [
                {"id": "diagnostic_atlas", "label": "Four-panel diagnostic atlas", "requires_run": True},
                {"id": "timeseries", "label": "Publication temporal diagnostics", "requires_run": True},
                {"id": "relationship", "label": "Driver relationship and lag figure", "requires_run": True},
                {"id": "study_region", "label": "Study-region map", "requires_run": False},
                {"id": "elevation", "label": "Elevation context map", "requires_run": False},
            ],
            "principles": [
                "Uses current dashboard dataset, period, elevation, and spatial selections.",
                "Supports arbitrary numeric variables and cross-dataset relationships.",
                "Source datasets are read-only; every output is a derived artifact.",
                "Every harmonization and statistical guardrail is reported with the result.",
            ],
        }

    def _selection(self, request: ResearchFrameworkRequest, spec: ResearchVariableSpec) -> OperationSelection:
        return OperationSelection(
            dataset=spec.dataset,
            variable=spec.variable,
            start_date=f"{request.year_start:04d}-01-01",
            end_date=f"{request.year_end:04d}-12-31",
            year_start=request.year_start,
            year_end=request.year_end,
            elev_min=request.elev_min,
            elev_max=request.elev_max,
            subregion_id=request.subregion_id,
        )

    @staticmethod
    def _aoi_subregion(request: ResearchFrameworkRequest) -> Optional[Dict[str, Any]]:
        payload = request.aoi_geojson
        if not payload:
            return None
        properties = payload.get("properties") if isinstance(payload.get("properties"), dict) else {}
        geometry = payload.get("geometry") if payload.get("type") == "Feature" else payload
        polygons = _aoi_to_polygons(geometry)
        bounds = _polygon_bounds(polygons)
        if not polygons or not bounds:
            raise ValueError("ROI polygon has no valid rings.")
        if (
            bounds["min_lat"] < -90
            or bounds["max_lat"] > 90
            or bounds["min_lon"] < -180
            or bounds["max_lon"] > 180
        ):
            raise ValueError("ROI polygon coordinates are out of WGS84 bounds.")
        vertex_count = sum(max(0, int(part["outer"].shape[0]) - 1) for part in polygons)
        if vertex_count > 2000:
            raise ValueError("ROI polygon is too complex. Use 2000 vertices or fewer.")
        return {
            "id": str(properties.get("id") or "custom_aoi"),
            "label": str(properties.get("label") or properties.get("name") or "ROI"),
            "kind": "aoi",
            "bounds": bounds,
            "polygons": polygons,
            "geometry": geometry,
        }

    def _load_cube(
        self,
        request: ResearchFrameworkRequest,
        spec: ResearchVariableSpec,
        index: int,
    ) -> DataCube:
        selection = self._selection(request, spec)
        static_reference = False
        try:
            manifest = self.loader.build_lazy_source_manifest(selection)
        except HTTPException as exc:
            # Static environmental covariates (for example terrain) carry one
            # reference date so they can share the dashboard's date contract.
            # They remain valid spatial drivers outside that reference year.
            state = self.loader.hooks.ensure_dataset_loaded(spec.dataset)
            reference_date = state.get("reference_date")
            if not reference_date or exc.status_code != 404:
                raise
            static_reference = True
            selection = OperationSelection(
                dataset=spec.dataset,
                variable=spec.variable,
                date=str(reference_date),
                elev_min=request.elev_min,
                elev_max=request.elev_max,
                subregion_id=request.subregion_id,
            )
            manifest = self.loader.build_lazy_source_manifest(selection)
        if manifest:
            frame = self._aggregate_parquet(manifest, spec, request)
            dataset_label = str(manifest.get("dataset_label") or spec.dataset)
        else:
            frame, dataset_label = self._aggregate_fallback(selection, spec, request)
        if frame.empty:
            raise ValueError(f"No values matched {spec.dataset} / {spec.variable} and the current filters.")

        frame = frame.replace([np.inf, -np.inf], np.nan).dropna(
            subset=["year", "latitude", "longitude", "value"]
        )
        frame["year"] = pd.to_numeric(frame["year"], errors="coerce").astype("Int64")
        frame = frame.dropna(subset=["year"])
        frame["year"] = frame["year"].astype(int)
        if not static_reference:
            frame = frame[(frame.year >= request.year_start) & (frame.year <= request.year_end)]
        if frame.empty:
            raise ValueError(f"No annual values remained for {spec.dataset} / {spec.variable}.")

        frame["latitude"] = pd.to_numeric(frame["latitude"], errors="coerce").round(6)
        frame["longitude"] = pd.to_numeric(frame["longitude"], errors="coerce").round(6)
        frame["elevation_m"] = pd.to_numeric(frame.get("elevation_m", 0), errors="coerce").fillna(0)
        combine_agg = spec.aggregation if spec.aggregation in AGGREGATIONS else "mean"
        frame = (
            frame.groupby(["year", "latitude", "longitude"], as_index=False, observed=True)
            .agg(value=("value", combine_agg), elevation_m=("elevation_m", "median"))
        )
        coordinates = pd.MultiIndex.from_frame(frame[["latitude", "longitude"]])
        frame["pixel_id"] = pd.factorize(coordinates, sort=True)[0]
        meta = (
            frame.groupby("pixel_id", as_index=True)
            .agg(latitude=("latitude", "first"), longitude=("longitude", "first"), elevation_m=("elevation_m", "median"))
            .sort_index()
        )
        years = np.sort(frame.year.unique()).astype(int)
        matrix = (
            frame.pivot_table(index="year", columns="pixel_id", values="value", aggfunc="mean")
            .reindex(index=years, columns=meta.index)
            .to_numpy(float)
        )
        return DataCube(
            key=_safe_key(index, spec),
            spec=spec,
            dataset_label=dataset_label,
            years=years,
            meta=meta,
            matrix=matrix,
            source_rows=int(len(frame)),
        )

    def _aggregate_parquet(
        self,
        manifest: Dict[str, Any],
        spec: ResearchVariableSpec,
        request: ResearchFrameworkRequest,
    ) -> pd.DataFrame:
        try:
            import duckdb
        except ImportError as exc:
            raise RuntimeError(
                "The generalized research engine requires DuckDB. Install backend requirements before running this analysis."
            ) from exc
        columns = manifest["physical_columns"]
        date_column = _quote_identifier(columns["date"])
        lat_column = _quote_identifier(columns["lat"])
        lon_column = _quote_identifier(columns["lon"])
        elev_column = _quote_identifier(columns["elev"])
        value_column = _quote_identifier(spec.variable)
        aggregate = AGGREGATIONS[spec.aggregation]
        files = ", ".join(_quote_literal(path) for path in manifest["files"])
        where = [
            f"YEAR(TRY_CAST({date_column} AS TIMESTAMP)) BETWEEN {int(request.year_start)} AND {int(request.year_end)}",
            f"TRY_CAST({elev_column} AS DOUBLE) BETWEEN {float(request.elev_min)} AND {float(request.elev_max)}",
            f"TRY_CAST({lat_column} AS DOUBLE) IS NOT NULL",
            f"TRY_CAST({lon_column} AS DOUBLE) IS NOT NULL",
            f"TRY_CAST({value_column} AS DOUBLE) IS NOT NULL",
        ]
        subregion = self._aoi_subregion(request) or manifest.get("subregion")
        spatial_bounds = None
        if subregion and subregion.get("bounds"):
            spatial_bounds = dict(subregion["bounds"])
        if spatial_bounds:
            where.extend(
                [
                    f"TRY_CAST({lat_column} AS DOUBLE) BETWEEN {float(spatial_bounds['min_lat'])} AND {float(spatial_bounds['max_lat'])}",
                    f"TRY_CAST({lon_column} AS DOUBLE) BETWEEN {float(spatial_bounds['min_lon'])} AND {float(spatial_bounds['max_lon'])}",
                ]
            )
        query = f"""
            SELECT
                YEAR(TRY_CAST({date_column} AS TIMESTAMP))::INTEGER AS year,
                ROUND(TRY_CAST({lat_column} AS DOUBLE), 6) AS latitude,
                ROUND(TRY_CAST({lon_column} AS DOUBLE), 6) AS longitude,
                MEDIAN(TRY_CAST({elev_column} AS DOUBLE)) AS elevation_m,
                {aggregate}(TRY_CAST({value_column} AS DOUBLE)) AS value
            FROM read_parquet([{files}], union_by_name=true)
            WHERE {' AND '.join(where)}
            GROUP BY year, latitude, longitude
            ORDER BY year, latitude, longitude
        """
        connection = duckdb.connect(database=":memory:")
        try:
            connection.execute("SET threads TO 4")
            frame = connection.execute(query).fetch_df()
        finally:
            connection.close()
        if subregion and subregion.get("polygons") and not frame.empty:
            frame = self._exact_polygon_filter(frame, subregion["polygons"])
        return frame

    @staticmethod
    def _exact_polygon_filter(frame: pd.DataFrame, polygon_parts: Iterable[dict]) -> pd.DataFrame:
        try:
            from shapely import contains_xy, intersects_xy
            from shapely.geometry import Polygon
            from shapely.ops import unary_union

            polygons = [
                Polygon(part["outer"], holes=part.get("holes") or [])
                for part in polygon_parts
                if part.get("outer") is not None and len(part["outer"]) >= 4
            ]
            if not polygons:
                return frame
            geometry = unary_union(polygons)
            lon = frame["longitude"].to_numpy(float)
            lat = frame["latitude"].to_numpy(float)
            mask = contains_xy(geometry, lon, lat) | intersects_xy(geometry, lon, lat)
            return frame.loc[mask].reset_index(drop=True)
        except ImportError:
            return frame

    def _aggregate_fallback(
        self,
        selection: OperationSelection,
        spec: ResearchVariableSpec,
        request: ResearchFrameworkRequest,
    ) -> tuple[pd.DataFrame, str]:
        frames = []
        dataset_label = spec.dataset
        aoi_subregion = self._aoi_subregion(request)
        for chunk, meta in self.loader.iter_selection_frames(selection, dates_per_chunk=24):
            dataset_label = str(meta.get("dataset_label") or dataset_label)
            if chunk.empty:
                continue
            subset = chunk[["date", "lat", "lon", "elev", "value"]].copy()
            subset["year"] = pd.to_datetime(subset["date"], errors="coerce").dt.year
            subset = subset.rename(columns={"lat": "latitude", "lon": "longitude", "elev": "elevation_m"})
            if aoi_subregion:
                bounds = aoi_subregion["bounds"]
                subset = subset[
                    subset.latitude.between(bounds["min_lat"], bounds["max_lat"])
                    & subset.longitude.between(bounds["min_lon"], bounds["max_lon"])
                ]
                subset = self._exact_polygon_filter(subset, aoi_subregion["polygons"])
            frames.append(subset)
        if not frames:
            return pd.DataFrame(columns=["year", "latitude", "longitude", "elevation_m", "value"]), dataset_label
        frame = pd.concat(frames, ignore_index=True)
        return (
            frame.groupby(["year", "latitude", "longitude"], as_index=False)
            .agg(value=("value", spec.aggregation), elevation_m=("elevation_m", "median")),
            dataset_label,
        )

    @staticmethod
    def _standardized(cube: DataCube, request: ResearchFrameworkRequest) -> tuple[np.ndarray, np.ndarray]:
        baseline = (cube.years >= int(request.baseline_start)) & (cube.years <= int(request.baseline_end))
        if baseline.sum() < 3:
            return np.full_like(cube.matrix, np.nan), baseline
        mean = np.nanmean(cube.matrix[baseline], axis=0)
        sd = np.nanstd(cube.matrix[baseline], axis=0, ddof=1)
        direction = 1.0 if cube.spec.direction == "positive" else -1.0
        z = np.divide(
            cube.matrix - mean[None, :],
            sd[None, :],
            out=np.full_like(cube.matrix, np.nan),
            where=sd[None, :] > 0,
        )
        return z * direction, baseline

    @staticmethod
    def _align_to_primary(primary: DataCube, related: DataCube) -> tuple[np.ndarray, dict]:
        longitude_scale = float(np.cos(np.deg2rad(primary.meta.latitude.mean())))
        source_xy = np.column_stack(
            [related.meta.latitude.to_numpy(float), related.meta.longitude.to_numpy(float) * longitude_scale]
        )
        target_xy = np.column_stack(
            [primary.meta.latitude.to_numpy(float), primary.meta.longitude.to_numpy(float) * longitude_scale]
        )
        distances, nearest = cKDTree(source_xy).query(target_xy, k=1)
        return related.matrix[:, nearest], {
            "method": "nearest-cell sampling to response grid",
            "median_offset_degrees": float(np.nanmedian(distances)),
            "maximum_offset_degrees": float(np.nanmax(distances)),
            "response_pixels": int(len(target_xy)),
            "source_pixels": int(len(source_xy)),
        }

    @staticmethod
    def _local_correlation(primary: np.ndarray, related: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        valid = np.isfinite(primary) & np.isfinite(related)
        n = valid.sum(axis=0).astype(float)
        x_mean = np.divide(np.where(valid, primary, 0).sum(axis=0), n, out=np.full(primary.shape[1], np.nan), where=n > 0)
        y_mean = np.divide(np.where(valid, related, 0).sum(axis=0), n, out=np.full(primary.shape[1], np.nan), where=n > 0)
        dx = np.where(valid, primary - x_mean[None, :], 0)
        dy = np.where(valid, related - y_mean[None, :], 0)
        denominator = np.sqrt((dx * dx).sum(axis=0) * (dy * dy).sum(axis=0))
        correlation = np.divide((dx * dy).sum(axis=0), denominator, out=np.full(primary.shape[1], np.nan), where=denominator > 0)
        correlation = np.clip(correlation, -1, 1)
        t_value = correlation * np.sqrt(np.divide(n - 2, np.maximum(1 - correlation**2, 1e-12)))
        p_value = 2 * stats.t.sf(np.abs(t_value), np.maximum(n - 2, 1))
        p_value[(n < 10) | ~np.isfinite(correlation)] = np.nan
        return correlation, p_value, n

    @staticmethod
    def _series_relationship(primary: DataCube, related: DataCube) -> tuple[dict, list[dict]]:
        primary_series = weighted_mean(primary.matrix, primary.weights)
        related_series = weighted_mean(related.matrix, related.weights)
        px = pd.Series(primary_series, index=primary.years)
        ry = pd.Series(related_series, index=related.years)
        common = px.index.intersection(ry.index)
        x = px.loc[common].to_numpy(float)
        y = ry.loc[common].to_numpy(float)
        valid = np.isfinite(x) & np.isfinite(y)
        result: dict = {"n": int(valid.sum())}
        if valid.sum() >= 4:
            pearson = stats.pearsonr(x[valid], y[valid])
            spearman = stats.spearmanr(x[valid], y[valid])
            regression = stats.linregress(y[valid], x[valid])
            result.update(
                {
                    "pearson_r": float(pearson.statistic),
                    "pearson_p": float(pearson.pvalue),
                    "spearman_rho": float(spearman.statistic),
                    "spearman_p": float(spearman.pvalue),
                    "response_per_driver_unit": float(regression.slope),
                    "regression_intercept": float(regression.intercept),
                    "regression_r_squared": float(regression.rvalue**2),
                }
            )
        lag_rows = []
        # Positive lag means the related variable leads the response.
        for lag in range(-5, 6):
            paired = pd.concat([px.rename("response"), ry.shift(lag).rename("related")], axis=1).dropna()
            correlation = stats.pearsonr(paired.response, paired.related) if len(paired) >= 4 else None
            lag_rows.append(
                {
                    "lag_years": lag,
                    "related_leads_response": lag > 0,
                    "n": int(len(paired)),
                    "pearson_r": float(correlation.statistic) if correlation else None,
                    "pearson_p": float(correlation.pvalue) if correlation else None,
                }
            )
        finite_lags = [row for row in lag_rows if row["pearson_r"] is not None]
        if finite_lags:
            best = max(finite_lags, key=lambda row: abs(row["pearson_r"]))
            result["strongest_lag_years"] = int(best["lag_years"])
            result["strongest_lag_r"] = float(best["pearson_r"])
        return result, lag_rows

    @staticmethod
    def _layer(
        layer_id: str,
        label: str,
        meta: pd.DataFrame,
        values: np.ndarray,
        max_points: int,
        *,
        sequential: bool = False,
        q_values: Optional[np.ndarray] = None,
    ) -> dict:
        frame = meta.reset_index(drop=True).copy()
        frame["map_value"] = np.asarray(values, dtype=float)
        if q_values is not None:
            frame["q_value"] = np.asarray(q_values, dtype=float)
        frame = frame[np.isfinite(frame.map_value)]
        if len(frame) > max_points:
            frame = frame.iloc[np.linspace(0, len(frame) - 1, max_points, dtype=int)]
        records = []
        for row in frame.itertuples(index=False):
            item = {
                "lat": float(row.latitude),
                "lon": float(row.longitude),
                "elev": float(row.elevation_m),
                "value": float(row.map_value),
            }
            if q_values is not None:
                item["significant"] = bool(np.isfinite(row.q_value) and row.q_value < 0.05)
            records.append(item)
        map_values = frame.map_value.to_numpy(float)
        return {
            "id": layer_id,
            "label": label,
            "sequential": sequential,
            "point_count": len(records),
            "min": float(np.nanmin(map_values)) if len(map_values) else None,
            "max": float(np.nanmax(map_values)) if len(map_values) else None,
            "data": records,
        }

    @staticmethod
    def _group_summary(metrics: pd.DataFrame, weights: np.ndarray) -> list[dict]:
        elevation = metrics.elevation_m.to_numpy(float)
        groups = [
            ("Selected domain", np.ones(len(metrics), dtype=bool)),
            ("<1500 m", elevation < 1500),
            ("1500–2999 m", (elevation >= 1500) & (elevation < 3000)),
            ("3000–4499 m", (elevation >= 3000) & (elevation < 4500)),
            ("≥4500 m", elevation >= 4500),
        ]
        output = []
        for label, mask in groups:
            if not np.any(mask):
                continue
            group_weights = weights[mask]
            trend_q = metrics.loc[mask, "trend_q_fdr"].to_numpy(float)
            change_q = metrics.loc[mask, "change_q_fdr"].to_numpy(float)
            emergence = metrics.loc[mask, "emergence_year"].to_numpy(float)
            output.append(
                {
                    "group": label,
                    "pixels": int(mask.sum()),
                    "mean_trend_per_decade": weighted_scalar(metrics.loc[mask, "trend_per_decade"], group_weights),
                    "trend_fdr_area_percent": weighted_percent(trend_q < 0.05, np.isfinite(trend_q), group_weights),
                    "recent_anomaly_z": weighted_scalar(metrics.loc[mask, "recent_anomaly_z"], group_weights),
                    "emerged_area_percent": weighted_percent(np.isfinite(emergence), np.ones(mask.sum(), dtype=bool), group_weights),
                    "change_fdr_area_percent": weighted_percent(change_q < 0.05, np.isfinite(change_q), group_weights),
                }
            )
        return output

    def analyze(self, request: ResearchFrameworkRequest) -> dict:
        cubes = [self._load_cube(request, spec, index) for index, spec in enumerate(request.variables)]
        primary = cubes[0]
        methods = set(request.methods)
        z_primary, baseline_mask = self._standardized(primary, request)
        baseline_years = primary.years[baseline_mask]
        recent_start = request.recent_start or max(request.year_start, request.year_end - 14)
        recent_mask = (primary.years >= recent_start) & (primary.years <= request.year_end)
        weights = primary.weights
        pixel_count = primary.matrix.shape[1]

        trend = np.full(pixel_count, np.nan)
        trend_p = np.full(pixel_count, np.nan)
        if "trend" in methods and len(primary.years) >= 3:
            trend = theil_sen_pixel_slopes(primary.years, primary.matrix) * 10
            _, trend_p = vectorized_ols(primary.years, primary.matrix)
        trend_q = bh_qvalues(trend_p)
        recent_anomaly = np.nanmean(z_primary[recent_mask], axis=0) if np.any(recent_mask) else np.full(pixel_count, np.nan)
        emergence = np.full(pixel_count, np.nan)
        if "emergence" in methods and len(primary.years) >= max(10, request.emergence_window):
            emergence = persistent_emergence(
                z_primary,
                primary.years,
                window=request.emergence_window,
                threshold=request.emergence_threshold,
                persistence_fraction=request.persistence_fraction,
            )
        change_year = np.full(pixel_count, np.nan)
        change_p = np.full(pixel_count, np.nan)
        if "change_point" in methods and len(primary.years) >= 10:
            change_year, change_p = pettitt_pixels(primary.years, primary.matrix)
        change_q = bh_qvalues(change_p)

        metrics = primary.meta.reset_index(drop=True).copy()
        metrics["trend_per_decade"] = trend
        metrics["trend_p_ols"] = trend_p
        metrics["trend_q_fdr"] = trend_q
        metrics["recent_anomaly_z"] = recent_anomaly
        metrics["emergence_year"] = emergence
        metrics["change_year"] = change_year
        metrics["change_p"] = change_p
        metrics["change_q_fdr"] = change_q

        primary_raw = weighted_mean(primary.matrix, weights)
        primary_z = weighted_mean(z_primary, weights)
        footprint = np.array(
            [weighted_percent(row >= request.anomaly_threshold, np.isfinite(row), weights) for row in z_primary]
        )
        annual = pd.DataFrame({"year": primary.years, "value": primary_raw, "z_mean": primary_z, "signal_area_percent": footprint})
        baseline_regional = np.nanmean(primary_raw[baseline_mask]) if np.any(baseline_mask) else np.nan
        annual["anomaly"] = annual.value - baseline_regional
        annual["compound_area_percent"] = np.nan
        annual[f"{primary.key}__value"] = primary_raw

        relationships = []
        relationship_layers = []
        relationship_rows = []
        harmonization = []
        compound_values = None
        for related_index, related in enumerate(cubes[1:], start=1):
            related_series = weighted_mean(related.matrix, related.weights)
            annual = annual.merge(
                pd.DataFrame({"year": related.years, f"{related.key}__value": related_series}),
                on="year",
                how="left",
            )
            series_stats, lag_rows = self._series_relationship(primary, related)
            aligned, harmonization_meta = self._align_to_primary(primary, related)
            harmonization_meta.update({"variable_key": related.key, "dataset": related.spec.dataset, "variable": related.spec.variable})
            harmonization.append(harmonization_meta)
            common_years = np.intersect1d(primary.years, related.years)
            p_indices = np.searchsorted(primary.years, common_years)
            r_indices = np.searchsorted(related.years, common_years)
            local_r, local_p, local_n = self._local_correlation(primary.matrix[p_indices], aligned[r_indices])
            local_q = bh_qvalues(local_p)
            related_spatial = np.nanmean(aligned, axis=0)
            if np.isfinite(recent_anomaly).sum() >= 4:
                response_spatial = recent_anomaly
                spatial_response_label = "recent response anomaly"
            elif np.isfinite(trend).sum() >= 4:
                response_spatial = trend
                spatial_response_label = "response trend"
            else:
                response_spatial = np.nanmean(primary.matrix, axis=0)
                spatial_response_label = "mean response"
            spatial_valid = np.isfinite(response_spatial) & np.isfinite(related_spatial)
            spatial_stats: dict = {"n": int(spatial_valid.sum()), "response_metric": spatial_response_label}
            if spatial_valid.sum() >= 4:
                spatial_pearson = stats.pearsonr(response_spatial[spatial_valid], related_spatial[spatial_valid])
                spatial_spearman = stats.spearmanr(response_spatial[spatial_valid], related_spatial[spatial_valid])
                spatial_regression = stats.linregress(related_spatial[spatial_valid], response_spatial[spatial_valid])
                spatial_stats.update(
                    {
                        "pearson_r": float(spatial_pearson.statistic),
                        "pearson_p": float(spatial_pearson.pvalue),
                        "spearman_rho": float(spatial_spearman.statistic),
                        "spearman_p": float(spatial_spearman.pvalue),
                        "response_per_driver_unit": float(spatial_regression.slope),
                        "regression_r_squared": float(spatial_regression.rvalue**2),
                    }
                )
            response_z = stats.zscore(response_spatial, nan_policy="omit")
            related_z = stats.zscore(related_spatial, nan_policy="omit")
            spatial_contribution = response_z * related_z
            relation = {
                "key": related.key,
                "dataset": {"id": related.spec.dataset, "label": related.dataset_label},
                "variable": {
                    "id": related.spec.variable,
                    "label": related.spec.label or _pretty_label(related.spec.variable),
                    "unit": related.spec.unit or "native units",
                    "aggregation": related.spec.aggregation,
                },
                "regional": series_stats,
                "spatial": spatial_stats,
                "lag_correlations": lag_rows,
                "local": {
                    "median_r": _finite_or_none(np.nanmedian(local_r)) if np.isfinite(local_r).any() else None,
                    "fdr_significant_area_percent": weighted_percent(local_q < 0.05, np.isfinite(local_q), weights),
                    "median_common_years": _finite_or_none(np.nanmedian(local_n)),
                },
                "harmonization": harmonization_meta,
            }
            relationships.append(relation)
            for lag in lag_rows:
                relationship_rows.append({"variable_key": related.key, **lag})
            if "relationships" in methods:
                has_local_relationship = np.isfinite(local_r).sum() >= 4
                layer = self._layer(
                    f"relationship_{related_index}",
                    (
                        f"Local temporal correlation: {related.spec.label or _pretty_label(related.spec.variable)}"
                        if has_local_relationship
                        else f"Spatial co-variation: {related.spec.label or _pretty_label(related.spec.variable)}"
                    ),
                    primary.meta,
                    local_r if has_local_relationship else spatial_contribution,
                    request.max_map_points,
                    q_values=local_q if has_local_relationship else None,
                )
                relationship_layers.append(layer)
            metrics[f"{related.key}__local_r"] = local_r
            metrics[f"{related.key}__local_q"] = local_q
            metrics[f"{related.key}__spatial_value"] = related_spatial
            metrics[f"{related.key}__spatial_response"] = response_spatial
            metrics[f"{related.key}__spatial_contribution"] = spatial_contribution

            if compound_values is None and "compound" in methods:
                related_aligned_cube = DataCube(
                    key=related.key,
                    spec=related.spec,
                    dataset_label=related.dataset_label,
                    years=related.years,
                    meta=primary.meta,
                    matrix=aligned,
                    source_rows=related.source_rows,
                )
                z_related, _ = self._standardized(related_aligned_cube, request)
                compound_values = np.full(len(primary.years), np.nan)
                for year_index, year in enumerate(primary.years):
                    match = np.where(related.years == year)[0]
                    if not len(match):
                        continue
                    overlap = (z_primary[year_index] >= request.anomaly_threshold) & (z_related[match[0]] >= request.anomaly_threshold)
                    valid = np.isfinite(z_primary[year_index]) & np.isfinite(z_related[match[0]])
                    compound_values[year_index] = weighted_percent(overlap, valid, weights)
                annual["compound_area_percent"] = compound_values

        trend_stats = regional_statistics(primary.years, primary_raw)
        headline = {
            "regional_sen_slope_per_decade": trend_stats.get("sen_slope_per_decade"),
            "regional_hac_p": trend_stats.get("hac_p"),
            "recent_mean_anomaly_z": weighted_scalar(recent_anomaly, weights),
            "spatial_fdr_trend_area_percent": weighted_percent(trend_q < 0.05, np.isfinite(trend_q), weights),
            "persistent_emerged_area_percent": weighted_percent(np.isfinite(emergence), np.ones(pixel_count, dtype=bool), weights),
            "median_emergence_year": _finite_or_none(np.nanmedian(emergence)) if np.isfinite(emergence).any() else None,
            "pettitt_fdr_area_percent": weighted_percent(change_q < 0.05, np.isfinite(change_q), weights),
            "median_fdr_change_year": _finite_or_none(np.nanmedian(change_year[change_q < 0.05])) if np.any(change_q < 0.05) else None,
            "largest_signal_year": int(primary.years[int(np.nanargmax(footprint))]) if np.isfinite(footprint).any() else None,
            "largest_signal_area_percent": _finite_or_none(np.nanmax(footprint)) if np.isfinite(footprint).any() else None,
        }
        if compound_values is not None and np.isfinite(compound_values).any():
            headline.update(
                {
                    "largest_compound_year": int(primary.years[int(np.nanargmax(compound_values))]),
                    "largest_compound_area_percent": float(np.nanmax(compound_values)),
                }
            )

        layers = []
        if "trend" in methods:
            layers.append(self._layer("trend", "Theil–Sen trend per decade", primary.meta, trend, request.max_map_points, q_values=trend_q))
        if "anomaly" in methods:
            layers.append(self._layer("anomaly", f"Recent anomaly ({recent_start}–{request.year_end}; baseline SD)", primary.meta, recent_anomaly, request.max_map_points))
        if "emergence" in methods:
            layers.append(self._layer("emergence", "Persistent signal emergence year", primary.meta, emergence, request.max_map_points, sequential=True))
        if "change_point" in methods:
            significant_change = np.where(change_q < 0.05, change_year, np.nan)
            layers.append(self._layer("change_point", "FDR-significant shift year", primary.meta, significant_change, request.max_map_points, sequential=True, q_values=change_q))
        layers.extend(relationship_layers)

        run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
        run_dir = self.output_root / run_id
        with self._lock:
            run_dir.mkdir(parents=True, exist_ok=False)
            annual.to_csv(run_dir / "annual_series.csv", index=False)
            metrics.to_parquet(run_dir / "pixel_metrics.parquet", index=False, compression="zstd")
            pd.DataFrame(relationship_rows).to_csv(run_dir / "relationships.csv", index=False)
            (run_dir / "request.json").write_text(request.model_dump_json(indent=2), encoding="utf-8")

        variable_items = [
            {
                "key": cube.key,
                "role": "response" if index == 0 else "related",
                "dataset": {"id": cube.spec.dataset, "label": cube.dataset_label},
                "id": cube.spec.variable,
                "label": cube.spec.label or _pretty_label(cube.spec.variable),
                "unit": cube.spec.unit or "native units",
                "aggregation": cube.spec.aggregation,
                "direction": cube.spec.direction,
                "years": [int(cube.years.min()), int(cube.years.max())],
                "year_count": int(len(cube.years)),
                "pixel_count": int(cube.matrix.shape[1]),
            }
            for index, cube in enumerate(cubes)
        ]
        selection = request.model_dump()
        selection["sector"] = "all"
        primary_variable = {
            "id": primary.spec.variable,
            "label": primary.spec.label or _pretty_label(primary.spec.variable),
            "unit": primary.spec.unit or "native units",
        }
        result = {
            "run_id": run_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "framework": "Generalized selection-aware research workflow",
            "selection": selection,
            "dataset": {"id": primary.spec.dataset, "label": primary.dataset_label},
            "variable": primary_variable,
            "variables": variable_items,
            "coverage": {
                "available_years": primary.years.tolist(),
                "year_count": int(len(primary.years)),
                "baseline_years": baseline_years.tolist(),
                "pixel_count": pixel_count,
                "recent_period": [int(recent_start), int(request.year_end)],
            },
            "headline": headline,
            "regional_statistics": trend_stats,
            "annual_series": annual.replace({np.nan: None}).to_dict("records"),
            "group_summary": self._group_summary(metrics, weights),
            "relationships": relationships,
            "harmonization": harmonization,
            "layers": layers,
            "interpretation_guardrails": [
                "Association, lag, emergence, and change points do not establish causal attribution.",
                "Related grids are harmonized by nearest-cell sampling and the reported offsets must be evaluated against native resolution.",
                "Pettitt identifies one candidate distributional shift; FDR controls multiplicity but not spatial dependence or product uncertainty.",
                "Short records and baselines below 10 years materially weaken robust inference.",
                "Direction controls anomaly interpretation only; raw observations are never modified.",
            ],
            "exports": {
                "annual_csv": f"/research/framework/runs/{run_id}/annual_series.csv",
                "pixel_parquet": f"/research/framework/runs/{run_id}/pixel_metrics.parquet",
                "relationships_csv": f"/research/framework/runs/{run_id}/relationships.csv",
                "summary_json": f"/research/framework/runs/{run_id}/summary.json",
                "request_json": f"/research/framework/runs/{run_id}/request.json",
            },
            "provenance": {
                "raw_data_modified": False,
                "output_directory": str(run_dir.relative_to(self.app_root)),
                "aggregation_level": "annual pixel",
                "response_grid": f"{primary.spec.dataset}/{primary.spec.variable}",
            },
        }
        clean = _finite_or_none(result)
        (run_dir / "summary.json").write_text(json.dumps(clean, indent=2), encoding="utf-8")
        return clean

    def run_dir(self, run_id: str) -> Path:
        if not run_id or any(character not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for character in run_id):
            raise ValueError("Invalid research run id")
        path = (self.output_root / run_id).resolve()
        if self.output_root not in path.parents or not path.is_dir():
            raise FileNotFoundError("Research framework run not found")
        return path
