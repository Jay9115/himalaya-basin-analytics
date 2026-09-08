# Fixed ERA5-Land/CHIRPS Research Workflow (Compatibility API)

> The user-facing dashboard now uses the generalized, selection-aware framework
> documented in `RESEARCH_FRAMEWORK.md`. This fixed workflow remains available
> for reproducibility of earlier ERA5-Land/CHIRPS runs and API compatibility; it
> is no longer presented as a separate home-level application module.

Research Studio is the guided, no-code research workflow in the Himalayan Basin Analytics app. It is additive: the Interactive Dashboard, Outcomes views, custom Python operations, and their API routes remain available.

## Scientific scope

- Period: 1981–2025
- Temperature and cryosphere-adjacent indicators: ERA5-Land annual research cube
- Precipitation totals, extremes, dry spells, intensity, and seasonality: CHIRPS annual research cube
- Spatial stratification: 27 project sub-basins, western/central/eastern sectors, and four elevation bands
- Terrain figure context: project SRTM overview grid and optional RGI 7.0 glacier outlines

The default design pairs ERA5-Land annual mean temperature with CHIRPS annual precipitation. Cross-product compound analysis samples the secondary product to the primary analysis grid by nearest cell and reports the median and maximum coordinate offset in every result.

## Implemented statistics

1. Area-weighted annual regional series using cosine-latitude weights.
2. Pixel-standardized anomalies relative to a user-selected baseline with missing-data-aware denominators.
3. Pixelwise Theil–Sen trend and regional Theil–Sen confidence interval.
4. Regional OLS inference with heteroskedasticity/autocorrelation-consistent covariance and Mann–Kendall rank inference.
5. Pixelwise OLS screening with Benjamini–Hochberg false-discovery-rate q-values.
6. Persistent signal-to-noise time of emergence using a centered running window, threshold, persistence fraction, and terminal-period check.
7. Pettitt single-shift screening with spatial FDR control.
8. Compound positive/negative anomaly footprints across paired variables and products.
9. Elevation-band and longitudinal-sector contrasts for trend, emergence, recent anomaly, and change-point area.

Time of emergence and change-point dates are statistical diagnostics, not causal attribution. These guardrails are returned with every run and shown in the interface.

## Read-only data design

Raw project holdings are never edited. The preparation utility reads verified local research caches and writes compact, derived annual Parquet cubes to `Database/Research_Ready/`:

```powershell
python backend\research_studio\prepare_research_ready_data.py
```

The generated manifest records source provenance, available years, variable metadata, pixel/row counts, known gaps, and `source_data_modified: false`.

Each analysis creates an isolated directory:

```text
Outcomes/Research_Studio/runs/<run-id>/
  request.json
  summary.json
  annual_series.csv
  pixel_metrics.parquet
  figures/
```

## Publication figure factory

The interface can generate four figure classes:

- Four-panel spatial diagnostic atlas
- Regional anomaly and compound-footprint chronicle
- Study-region locator with 27 numbered sub-basins and longitudinal sectors
- SRTM elevation/hillshade map with contours and optional glacier context

Every figure request produces a 600-dpi PNG, flattened RGB LZW-compressed TIFF, and PDF. Figure rendering is serialized on desktop deployments to avoid excessive memory contention.

## API

- `GET /research/capabilities`
- `POST /research/analyze`
- `POST /research/figures`
- `GET /research/runs/{run_id}`
- `GET /research/runs/{run_id}/{artifact_path}`

Analysis and figure requests are validated with Pydantic. Run identifiers and artifact paths are constrained to prevent path traversal. Only declared analysis files and supported figure formats can be downloaded.

## Verification

```powershell
python -m unittest backend.test_research_studio -v
cd frontend
npm run build
```

The research tests cover capability provenance, FDR behavior, cross-product ERA5-Land/CHIRPS harmonization, isolated artifact creation, and run-path safety.
