"""Journal-quality figure factory for Research Studio.

The factory only reads project data. Every generated file is isolated below a
Research Studio run directory so raw holdings and the existing app outputs are
never changed.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

import geopandas as gpd
import matplotlib

matplotlib.use("Agg")

import matplotlib.patheffects as pe
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.colors import LinearSegmentedColormap, Normalize, TwoSlopeNorm
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
from PIL import Image
from pyproj import Geod
from scipy import ndimage

from .analysis import ResearchService
from .models import ResearchFigureRequest


INK = "#17252b"
MUTED = "#62727a"
GRID = "#bdc9cd"
OCEAN = "#eef5f6"
WEST = "#3f77a8"
CENTRAL = "#e3a13a"
EAST = "#24916c"


class FigureService:
    def __init__(self, app_root: Path, research: ResearchService):
        self.app_root = Path(app_root).resolve()
        self.research = research
        self.boundary_path = self.app_root / "Himalaya_shape" / "him_watershed.shp"
        self.dem_path = self.app_root / "Database" / "DEM" / "Himalaya_SRTM_DEM-0000000000-0000000000.parquet"
        self.countries_path = self.app_root / "Map_handle" / "ne_110m_admin_0_countries.zip"
        workspace = self.app_root.parents[1]
        self.glacier_paths = [
            workspace / "Map_handle_backup" / "Glacier_shp" / "RGI2000-v7.0-G-14_south_asia_west" / "RGI2000-v7.0-G-14_south_asia_west.shp",
            workspace / "Map_handle_backup" / "Glacier_shp" / "RGI2000-v7.0-G-15_south_asia_east" / "RGI2000-v7.0-G-15_south_asia_east.shp",
        ]
        self._configure_style()

    @staticmethod
    def _configure_style() -> None:
        matplotlib.rcParams.update(
            {
                "font.family": "DejaVu Sans",
                "font.size": 9,
                "axes.titlesize": 11.5,
                "axes.titleweight": "bold",
                "axes.labelsize": 9.5,
                "axes.linewidth": 0.75,
                "xtick.labelsize": 8,
                "ytick.labelsize": 8,
                "savefig.facecolor": "white",
                "pdf.fonttype": 42,
                "ps.fonttype": 42,
            }
        )

    def create(self, request: ResearchFigureRequest) -> dict:
        if request.run_id:
            run_id = request.run_id
            run_dir = self.research.run_dir(run_id)
        else:
            run_id = datetime.now(timezone.utc).strftime("figure-%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8]
            run_dir = self.research.output_root / run_id
            run_dir.mkdir(parents=True, exist_ok=False)
            (run_dir / "request.json").write_text(request.model_dump_json(indent=2), encoding="utf-8")

        figure_dir = run_dir / "figures"
        figure_dir.mkdir(exist_ok=True)
        if request.figure_type == "study_region":
            fig, stem = self._study_region(request.title), "study_region_overview"
        elif request.figure_type == "elevation":
            fig, stem = self._elevation(request.title, request.include_glaciers), "study_region_elevation"
        elif request.figure_type == "timeseries":
            fig, stem = self._timeseries(run_dir, request.title), "research_timeseries"
        else:
            fig, stem = self._diagnostic_atlas(run_dir, request.title), "research_diagnostic_atlas"

        paths = self._save_all(fig, figure_dir, stem, request.dpi)
        return {
            "run_id": run_id,
            "figure_type": request.figure_type,
            "formats": {
                suffix: f"/research/runs/{run_id}/figures/{path.name}"
                for suffix, path in paths.items()
            },
            "metadata": {
                "png_dpi": request.dpi,
                "tiff_dpi": request.dpi,
                "pdf_raster_dpi": 300,
                "crs": "EPSG:4326",
                "raw_data_modified": False,
            },
        }

    @staticmethod
    def _save_all(fig: plt.Figure, directory: Path, stem: str, dpi: int) -> dict[str, Path]:
        paths = {kind: directory / f"{stem}.{kind}" for kind in ("png", "pdf", "tif")}
        fig.savefig(paths["png"], dpi=dpi, bbox_inches="tight")
        fig.savefig(paths["pdf"], dpi=300, bbox_inches="tight")
        fig.savefig(paths["tif"], dpi=dpi, bbox_inches="tight", pil_kwargs={"compression": "tiff_lzw"})
        with Image.open(paths["tif"]) as source:
            rgba = source.convert("RGBA")
            rgb = Image.new("RGB", rgba.size, "white")
            rgb.paste(rgba, mask=rgba.getchannel("A"))
            rgb.save(paths["tif"], compression="tiff_lzw", dpi=(dpi, dpi))
        plt.close(fig)
        return paths

    def _basins(self) -> gpd.GeoDataFrame:
        if not self.boundary_path.exists():
            raise FileNotFoundError("Himalayan watershed boundary is unavailable")
        basins = gpd.read_file(self.boundary_path).to_crs(4326).sort_values("Subbasin").reset_index(drop=True)
        basins["sector"] = np.select(
            [basins["Long_"] < 80, basins["Long_"] < 88],
            ["Western (<80°E)", "Central (80–88°E)"],
            default="Eastern (≥88°E)",
        )
        return basins

    def _countries(self) -> gpd.GeoDataFrame:
        if not self.countries_path.exists():
            return gpd.GeoDataFrame(geometry=[], crs=4326)
        return gpd.read_file(f"zip://{self.countries_path}").to_crs(4326)

    def _glaciers(self, bounds: Iterable[float]) -> gpd.GeoDataFrame:
        layers = []
        bbox = tuple(float(value) for value in bounds)
        for path in self.glacier_paths:
            if path.exists():
                layer = gpd.read_file(path, bbox=bbox)
                if not layer.empty:
                    layers.append(layer.to_crs(4326)[["geometry"]])
        if not layers:
            return gpd.GeoDataFrame(geometry=[], crs=4326)
        return gpd.GeoDataFrame(geometry=pd.concat([layer.geometry for layer in layers], ignore_index=True), crs=4326)

    @staticmethod
    def _geo_axes(ax: plt.Axes, bounds: np.ndarray, pad_x: float = 0.65, pad_y: float = 0.45) -> None:
        xmin, ymin, xmax, ymax = bounds
        ax.set_xlim(xmin - pad_x, xmax + pad_x)
        ax.set_ylim(ymin - pad_y, ymax + pad_y)
        ax.set_xlabel("Longitude (°E)")
        ax.set_ylabel("Latitude (°N)")
        ax.set_xticks(np.arange(75, 97, 5))
        ax.set_yticks(np.arange(28, 38, 2))
        ax.grid(color=GRID, linewidth=0.4, linestyle=(0, (2, 3)), zorder=0)
        ax.set_facecolor(OCEAN)
        ax.set_aspect(1 / np.cos(np.deg2rad(np.mean([ymin, ymax]))))

    @staticmethod
    def _north_arrow(ax: plt.Axes, x: float = 0.965, y: float = 0.86) -> None:
        ax.annotate(
            "N", xy=(x, y + 0.09), xytext=(x, y), xycoords="axes fraction",
            ha="center", va="center", fontsize=10, fontweight="bold",
            arrowprops=dict(arrowstyle="-|>", color=INK, lw=1.2, mutation_scale=13), zorder=30,
        )

    @staticmethod
    def _scale_bar(ax: plt.Axes, length_km: int = 500, lon: float = 73.6, lat: float = 27.35) -> None:
        lon2, _, _ = Geod(ellps="WGS84").fwd(lon, lat, 90, length_km * 1000)
        midpoint = (lon + lon2) / 2
        ax.plot([lon, lon2], [lat, lat], color="white", lw=4, zorder=25)
        ax.plot([lon, lon2], [lat, lat], color=INK, lw=1.5, zorder=26)
        for x in [lon, lon2]:
            ax.plot([x, x], [lat - 0.07, lat + 0.07], color=INK, lw=1.15, zorder=26)
        ax.text(
            midpoint, lat + 0.13, f"{length_km} km", ha="center", va="bottom", fontsize=8,
            path_effects=[pe.withStroke(linewidth=2.2, foreground="white")], zorder=27,
        )

    @staticmethod
    def _panel(ax: plt.Axes, label: str) -> None:
        ax.text(
            0.012, 0.975, label, transform=ax.transAxes, ha="left", va="top",
            fontsize=11, fontweight="bold", color="white",
            bbox=dict(boxstyle="round,pad=0.2", fc=INK, ec="none", alpha=0.96), zorder=50,
        )

    def _study_region(self, title: str | None) -> plt.Figure:
        basins, countries = self._basins(), self._countries()
        bounds, region = basins.total_bounds, basins.dissolve()
        fig = plt.figure(figsize=(13.2, 6.2))
        grid = fig.add_gridspec(1, 2, width_ratios=[1.05, 3.85], wspace=0.04)
        locator, ax = fig.add_subplot(grid[0, 0]), fig.add_subplot(grid[0, 1])

        locator.set_facecolor(OCEAN)
        if not countries.empty:
            countries.plot(ax=locator, facecolor="#f4f1e9", edgecolor="#7d8589", linewidth=0.38, zorder=1)
        region.plot(ax=locator, facecolor="#c43c39", edgecolor="white", linewidth=0.55, zorder=4)
        locator.set(xlim=(63, 107), ylim=(19, 42), xlabel="Longitude (°E)", ylabel="Latitude (°N)")
        locator.set_aspect(1 / np.cos(np.deg2rad(30)))
        locator.set_xticks([70, 80, 90, 100]); locator.set_yticks([20, 30, 40])
        locator.grid(color=GRID, linewidth=0.4, linestyle=(0, (2, 3)), zorder=0)
        locator.set_title("Regional location", fontsize=10.5, pad=7)
        self._panel(locator, "a")

        self._geo_axes(ax, bounds)
        if not countries.empty:
            countries.cx[bounds[0]-1:bounds[2]+1, bounds[1]-1:bounds[3]+1].boundary.plot(
                ax=ax, color="#858c90", linewidth=0.55, linestyle=(0, (4, 3)), zorder=1
            )
        colors = {"Western (<80°E)": WEST, "Central (80–88°E)": CENTRAL, "Eastern (≥88°E)": EAST}
        for sector, color in colors.items():
            basins.loc[basins["sector"] == sector].plot(
                ax=ax, facecolor=color, edgecolor="white", linewidth=0.58, alpha=0.91, zorder=5
            )
        basins.boundary.plot(ax=ax, color=INK, linewidth=0.46, zorder=7)
        region.boundary.plot(ax=ax, color="#0d1519", linewidth=1.15, zorder=8)
        for meridian in [80, 88]:
            ax.axvline(meridian, color="#424b50", lw=0.7, ls=(0, (5, 4)), alpha=0.8, zorder=4)
        for row in basins.itertuples():
            ax.text(
                float(row.Long_), float(row.Lat), str(int(row.Subbasin)), ha="center", va="center",
                fontsize=6.1, fontweight="bold", color=INK,
                path_effects=[pe.withStroke(linewidth=1.8, foreground="white")], zorder=12,
            )
        self._scale_bar(ax); self._north_arrow(ax); self._panel(ax, "b")
        ax.set_title("Himalayan study domain and 27 analysis sub-basins", pad=9)
        fig.legend(
            handles=[Patch(facecolor=color, label=sector) for sector, color in colors.items()]
            + [Line2D([0], [0], color=INK, lw=0.8, label="Sub-basin boundary")],
            loc="lower left", bbox_to_anchor=(0.108, 0.105), frameon=True, fontsize=7.5,
        )
        fig.suptitle(title or "Study region across the Himalayan arc", fontsize=15, fontweight="bold", y=0.985)
        fig.text(
            0.995, 0.012,
            "Boundary: project Himalayan watershed layer  |  Locator: Natural Earth 1:110m  |  CRS: WGS 84",
            ha="right", fontsize=7.2, color=MUTED,
        )
        return fig

    @staticmethod
    def _dem_grid(dem: gpd.GeoDataFrame) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        x, y = dem.geometry.x.to_numpy(), dem.geometry.y.to_numpy()
        ux, uy = np.unique(x), np.unique(y)
        grid = np.full((len(uy), len(ux)), np.nan, dtype=np.float32)
        grid[np.searchsorted(uy, y), np.searchsorted(ux, x)] = dem["elevation_m"].to_numpy(float)
        return ux, uy, grid

    @staticmethod
    def _hillshade(grid: np.ndarray, latitude: float) -> np.ndarray:
        valid = np.isfinite(grid)
        nearest = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
        filled = grid[tuple(nearest)]
        gy, gx = np.gradient(filled, 0.02883 * 111_320, 0.02878 * 111_320 * np.cos(np.deg2rad(latitude)))
        slope = np.pi / 2 - np.arctan(np.sqrt(gx * gx + gy * gy))
        aspect = np.arctan2(-gx, gy)
        azimuth, altitude = np.deg2rad(315), np.deg2rad(42)
        shade = np.sin(altitude) * np.sin(slope) + np.cos(altitude) * np.cos(slope) * np.cos(azimuth - aspect)
        shade = (shade - np.nanmin(shade)) / (np.nanmax(shade) - np.nanmin(shade))
        shade[~valid] = np.nan
        return shade

    def _elevation(self, title: str | None, include_glaciers: bool) -> plt.Figure:
        if not self.dem_path.exists():
            raise FileNotFoundError("SRTM overview layer is unavailable")
        basins, countries, dem = self._basins(), self._countries(), gpd.read_parquet(self.dem_path).to_crs(4326)
        bounds = basins.total_bounds
        glaciers = self._glaciers(bounds) if include_glaciers else gpd.GeoDataFrame(geometry=[], crs=4326)
        x, y, z = self._dem_grid(dem)
        shade = self._hillshade(z, float(np.mean(y)))
        valid = np.isfinite(z)
        nearest = ndimage.distance_transform_edt(~valid, return_distances=False, return_indices=True)
        contour_z = ndimage.gaussian_filter(z[tuple(nearest)], sigma=2.0); contour_z[~valid] = np.nan
        cmap = LinearSegmentedColormap.from_list(
            "himalaya_elevation",
            ["#2d7f5e", "#62a968", "#b8c979", "#d9c486", "#b78a5c", "#8a6650", "#b6aaa1", "#e7e3df", "#ffffff"],
        )
        fig, ax = plt.subplots(figsize=(13.2, 6.2))
        self._geo_axes(ax, bounds)
        if not countries.empty:
            countries.cx[bounds[0]-1:bounds[2]+1, bounds[1]-1:bounds[3]+1].boundary.plot(
                ax=ax, color="#757d82", linewidth=0.5, linestyle=(0, (4, 3)), zorder=1
            )
        mesh = ax.pcolormesh(x, y, z, cmap=cmap, norm=Normalize(0, 7500), shading="nearest", rasterized=True, zorder=2)
        ax.imshow(
            shade, extent=[x.min(), x.max(), y.min(), y.max()], origin="lower", cmap="gray",
            alpha=np.where(np.isfinite(shade), 0.27, 0), interpolation="bilinear", zorder=3,
        )
        ax.contour(x, y, contour_z, levels=[1500, 3000, 4500], colors="#3b4449", linewidths=0.36, linestyles="--", alpha=0.56, zorder=5)
        if not glaciers.empty:
            glaciers.plot(ax=ax, facecolor="#c9eff8", edgecolor="#287c9a", linewidth=0.08, alpha=0.72, rasterized=True, zorder=7)
        basins.boundary.plot(ax=ax, color=INK, linewidth=0.4, alpha=0.88, zorder=8)
        basins.dissolve().boundary.plot(ax=ax, color="#0e1519", linewidth=1.15, zorder=9)
        cbar = fig.colorbar(mesh, ax=ax, pad=0.018, fraction=0.027, shrink=0.86)
        cbar.set_label("Elevation above mean sea level (m)", labelpad=8)
        cbar.set_ticks([0, 1500, 3000, 4500, 6000, 7500])
        handles = [
            Line2D([0], [0], color=INK, lw=0.7, label="Sub-basin boundary"),
            Line2D([0], [0], color="#3b4449", lw=0.8, ls="--", label="1,500 / 3,000 / 4,500 m contours"),
        ]
        if not glaciers.empty:
            handles.insert(1, Patch(facecolor="#c9eff8", edgecolor="#287c9a", label="RGI 7.0 glacier outline"))
        ax.legend(handles=handles, loc="upper center", bbox_to_anchor=(0.56, 0.985), frameon=True, fontsize=7.8, ncol=len(handles))
        self._scale_bar(ax); self._north_arrow(ax)
        ax.set_title(title or "Elevation and topographic structure of the Himalayan study region", pad=9)
        fig.text(
            0.995, 0.012,
            "Terrain: project SRTM overview (~3 km display grid; source manifest retained)  |  CRS: WGS 84",
            ha="right", fontsize=7.2, color=MUTED,
        )
        return fig

    @staticmethod
    def _load_summary(run_dir: Path) -> dict:
        path = run_dir / "summary.json"
        if not path.exists():
            raise FileNotFoundError("Run summary is unavailable; execute an analysis first")
        return json.loads(path.read_text(encoding="utf-8"))

    def _timeseries(self, run_dir: Path, title: str | None) -> plt.Figure:
        summary = self._load_summary(run_dir)
        series = pd.read_csv(run_dir / "annual_series.csv")
        selection, variable = summary["selection"], summary["variable"]
        has_compound = series["compound_area_percent"].notna().any()
        rows = 3 if has_compound else 2
        fig, axes = plt.subplots(rows, 1, figsize=(11.2, 3.1 * rows), sharex=True, constrained_layout=True)
        axes = np.atleast_1d(axes)
        for ax in axes:
            ax.grid(axis="y", color=GRID, lw=0.45, ls=(0, (2, 3)))
            ax.spines[["top", "right"]].set_visible(False)
            ax.axvspan(selection["baseline_start"], selection["baseline_end"], color="#dde9e7", alpha=0.65, zorder=0)
        axes[0].plot(series.year, series.value, color="#126e65", lw=1.65, marker="o", ms=2.4)
        axes[0].set_ylabel(f"{variable['label']}\n({variable['unit']})")
        axes[0].set_title("a  Area-weighted regional series", loc="left")
        axes[1].axhline(0, color=INK, lw=0.65)
        axes[1].fill_between(series.year, 0, series.z_mean, where=series.z_mean >= 0, color="#d95f50", alpha=0.72)
        axes[1].fill_between(series.year, 0, series.z_mean, where=series.z_mean < 0, color="#3c78b4", alpha=0.72)
        axes[1].plot(series.year, series.z_mean, color=INK, lw=0.7)
        axes[1].set_ylabel("Mean standardized\nanomaly (SD)")
        axes[1].set_title("b  Baseline-standardized regional anomaly", loc="left")
        if has_compound:
            axes[2].plot(series.year, series.signal_area_percent, color="#d47827", lw=1.35, label="Primary signal footprint")
            axes[2].plot(series.year, series.compound_area_percent, color="#7b4a9e", lw=1.55, label="Compound footprint")
            axes[2].fill_between(series.year, 0, series.compound_area_percent, color="#7b4a9e", alpha=0.15)
            axes[2].set_ylabel("Affected area (%)"); axes[2].legend(frameon=False, ncol=2, loc="upper left")
            axes[2].set_title("c  Spatial footprint of concurrent anomalies", loc="left")
        else:
            twin = axes[1].twinx()
            twin.plot(series.year, series.signal_area_percent, color="#d47827", lw=1.15, ls="--")
            twin.set_ylabel("Signal area (%)", color="#a85b19")
        axes[-1].set_xlabel("Year")
        fig.suptitle(title or f"Temporal diagnostics: {variable['label']} ({selection['year_start']}–{selection['year_end']})", fontsize=14, fontweight="bold")
        fig.text(
            0.5, -0.01,
            "Shaded interval = selected climatological baseline. Regional aggregation uses latitude-area weights.",
            ha="center", fontsize=7.4, color=MUTED,
        )
        return fig

    def _diagnostic_atlas(self, run_dir: Path, title: str | None) -> plt.Figure:
        summary = self._load_summary(run_dir)
        pixels, basins = pd.read_parquet(run_dir / "pixel_metrics.parquet"), self._basins()
        variable, selection = summary["variable"], summary["selection"]
        panels = [
            ("trend_per_decade", f"a  Theil–Sen trend ({variable['unit']} decade⁻¹)", "RdBu_r", False),
            ("recent_anomaly_z", "b  Recent anomaly (baseline SD)", "PuOr_r", False),
            ("emergence_year", "c  Persistent signal emergence", "viridis", True),
            ("change_year", "d  FDR-significant median-shift year", "plasma", True),
        ]
        fig, axes = plt.subplots(2, 2, figsize=(12.4, 7.8), constrained_layout=True)
        bounds = basins.total_bounds
        for ax, (column, label, cmap, sequential) in zip(axes.ravel(), panels):
            self._geo_axes(ax, bounds, 0.45, 0.3)
            frame = pixels[np.isfinite(pixels[column])].copy()
            if column == "change_year":
                frame = frame[frame["change_q_fdr"] < 0.05]
            values = frame[column].to_numpy(float)
            if len(values):
                if sequential:
                    lo, hi = np.nanpercentile(values, [2, 98]) if len(values) > 10 else (np.nanmin(values), np.nanmax(values))
                    norm = Normalize(lo, hi if hi > lo else lo + 1)
                else:
                    limit = max(float(np.nanpercentile(np.abs(values), 98)), 1e-6)
                    norm = TwoSlopeNorm(vmin=-limit, vcenter=0, vmax=limit)
                points = ax.scatter(
                    frame.longitude, frame.latitude, c=values, s=3.5, cmap=cmap, norm=norm,
                    linewidths=0, rasterized=True, zorder=3,
                )
                cbar = fig.colorbar(points, ax=ax, pad=0.01, fraction=0.04, shrink=0.82)
                cbar.ax.tick_params(labelsize=7)
            else:
                ax.text(0.5, 0.5, "No FDR-significant pixels", transform=ax.transAxes, ha="center", color=MUTED)
            basins.boundary.plot(ax=ax, color=INK, linewidth=0.28, zorder=5)
            basins.dissolve().boundary.plot(ax=ax, color="#0d1519", linewidth=0.75, zorder=6)
            ax.set_title(label, loc="left", pad=5)
        headline = summary["headline"]
        fig.suptitle(title or f"Spatial diagnostic atlas: {variable['label']} ({selection['year_start']}–{selection['year_end']})", fontsize=14, fontweight="bold")
        fig.text(
            0.5, 0.003,
            f"Pixelwise trend and Pettitt screening; Benjamini–Hochberg FDR q<0.05. "
            f"Persistent-emergence area: {headline.get('persistent_emerged_area_percent', 0):.1f}%  |  CRS: WGS 84",
            ha="center", fontsize=7.4, color=MUTED,
        )
        return fig
