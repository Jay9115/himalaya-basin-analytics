from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy import stats

from .figures import GRID, INK, MUTED, FigureService
from .framework_analysis import ResearchFrameworkService
from .framework_models import ResearchFrameworkFigureRequest


class ResearchFrameworkFigureService(FigureService):
    def __init__(self, app_root, research: ResearchFrameworkService):
        super().__init__(app_root, research)  # type: ignore[arg-type]
        self.research = research

    def create(self, request: ResearchFrameworkFigureRequest) -> dict:
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
        elif request.figure_type == "relationship":
            fig, stem = self._relationship(run_dir, request.title), "research_relationship"
        else:
            fig, stem = self._diagnostic_atlas(run_dir, request.title), "research_diagnostic_atlas"

        paths = self._save_all(fig, figure_dir, stem, request.dpi)
        return {
            "run_id": run_id,
            "figure_type": request.figure_type,
            "formats": {
                suffix: f"/research/framework/runs/{run_id}/figures/{path.name}"
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

    def _relationship(self, run_dir, title: str | None) -> plt.Figure:
        summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
        relationships = summary.get("relationships") or []
        if not relationships:
            raise ValueError("Select at least one related variable before creating a relationship figure.")
        relation = relationships[0]
        primary = summary["variable"]
        related = relation["variable"]
        annual = pd.read_csv(run_dir / "annual_series.csv")
        primary_values = annual["value"]
        related_column = f"{relation['key']}__value"
        if related_column not in annual:
            raise ValueError("Related annual series is unavailable for this run.")
        related_values = annual[related_column]
        valid = np.isfinite(primary_values) & np.isfinite(related_values)

        relationship_scope = "annual regional"
        relationship_stats = relation.get("regional") or {}
        x_label = f"{related['label']} ({related['unit']})"
        y_label = f"{primary['label']} ({primary['unit']})"
        if valid.sum() < 4:
            pixels = pd.read_parquet(run_dir / "pixel_metrics.parquet")
            x_column = f"{relation['key']}__spatial_value"
            y_column = f"{relation['key']}__spatial_response"
            if x_column not in pixels or y_column not in pixels:
                raise ValueError("Neither temporal nor spatial relationship pairs are available for this run.")
            related_values = pixels[x_column]
            primary_values = pixels[y_column]
            valid = np.isfinite(primary_values) & np.isfinite(related_values)
            relationship_scope = "spatial cross-section"
            relationship_stats = relation.get("spatial") or {}
            x_label = f"{related['label']} (spatial value; {related['unit']})"
            y_label = f"{relationship_stats.get('response_metric', 'response metric')}"

        fig, axes = plt.subplots(1, 2, figsize=(11.4, 4.4), constrained_layout=True)
        for ax in axes:
            ax.grid(color=GRID, lw=0.45, ls=(0, (2, 3)))
            ax.spines[["top", "right"]].set_visible(False)
        axes[0].scatter(related_values[valid], primary_values[valid], s=27, color="#176d68", alpha=0.76, edgecolor="white", linewidth=0.35)
        if valid.sum() >= 4:
            fit = stats.linregress(related_values[valid], primary_values[valid])
            x_line = np.linspace(float(related_values[valid].min()), float(related_values[valid].max()), 100)
            axes[0].plot(x_line, fit.intercept + fit.slope * x_line, color="#d15c4b", lw=1.45)
            axes[0].text(
                0.03,
                0.96,
                f"r = {fit.rvalue:.2f}\np = {fit.pvalue:.3g}\nn = {valid.sum()}",
                transform=axes[0].transAxes,
                va="top",
                color=INK,
                bbox={"boxstyle": "round,pad=0.35", "facecolor": "white", "edgecolor": "#cbd5d6", "alpha": 0.92},
            )
        axes[0].set_xlabel(x_label)
        axes[0].set_ylabel(y_label)
        axes[0].set_title(f"a  {relationship_scope.title()} relationship", loc="left")

        lags = pd.DataFrame(relation["lag_correlations"])
        axes[1].axhline(0, color=INK, lw=0.7)
        axes[1].bar(
            lags.lag_years,
            lags.pearson_r,
            color=np.where(lags.pearson_r >= 0, "#d47827", "#3c78b4"),
            width=0.75,
        )
        axes[1].set_xticks(lags.lag_years)
        axes[1].set_xlabel("Lag (years; positive = related variable leads)")
        axes[1].set_ylabel("Pearson correlation")
        axes[1].set_ylim(-1, 1)
        axes[1].set_title("b  Lead–lag sensitivity", loc="left")
        fig.suptitle(title or f"Relationship diagnostics: {primary['label']} × {related['label']}", fontsize=14, fontweight="bold")
        harmonization = relation.get("harmonization", {})
        fig.text(
            0.5,
            0.005,
            f"Annual association is non-causal. Spatial comparison: {harmonization.get('method', 'reported in run metadata')}; "
            f"median offset {harmonization.get('median_offset_degrees', float('nan')):.3f}°.",
            ha="center",
            fontsize=7.4,
            color=MUTED,
        )
        return fig
