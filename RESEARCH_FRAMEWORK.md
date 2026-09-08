# General Research Framework

The Research Toolkit is integrated into the Interactive Dashboard. It is not a
separate climate-study module: it applies a reusable research workflow to the
dashboard's current dataset, response variable, period, elevation range,
subregion, and drawn spatial bounds.

## Research contract

- One response variable linked to the live dashboard.
- Up to three related numeric variables from any loaded dataset.
- Independent annual reducer per variable: mean, sum, minimum, maximum, or median.
- Positive or negative signal direction for standardized anomaly interpretation.
- Current elevation, subregion, and rectangular selection passed through unchanged.
- Source datasets are read-only. Only derived products are written.

The response grid is the spatial reference. Related grids are sampled to it by
nearest cell, and each run reports the source/response pixel counts plus median
and maximum coordinate offsets. Static covariates such as SRTM terrain can be
used as spatial environmental drivers outside their dashboard reference year.

## Reusable methods

1. Cosine-latitude weighted annual regional series.
2. Baseline-standardized pixel anomalies and affected-area footprints.
3. Pixelwise Theil–Sen slopes with regional Theil–Sen confidence intervals.
4. Regional OLS with HAC covariance and Mann–Kendall rank inference.
5. Pixelwise OLS screening with Benjamini–Hochberg FDR q-values.
6. Persistent signal-to-noise time of emergence.
7. Pettitt candidate median shifts with spatial FDR control.
8. Regional Pearson and Spearman relationships.
9. Lead–lag correlations from -5 to +5 years; positive lag means the related variable leads the response.
10. Spatial cross-sectional relationships, including static environmental drivers.
11. Pixel-local temporal correlations where at least 10 overlapping years exist.
12. Joint standardized anomaly footprints for the response and first related variable.

These are statistical diagnostics. Association, lags, emergence, and candidate
shift dates do not establish causal attribution.

## Derived outputs

Every analysis creates an isolated directory:

```text
Outcomes/Research_Framework/runs/<run-id>/
  request.json
  summary.json
  annual_series.csv
  pixel_metrics.parquet
  relationships.csv
  figures/
```

The integrated bottom dock exposes headline statistics, selectable map layers,
the regional series, relationship summaries, downloads, and publication figure
generation. Figures are available as PNG, LZW-compressed TIFF, and PDF at up to
600 dpi.

## API

- `GET /research/framework/capabilities`
- `POST /research/framework/analyze`
- `POST /research/framework/figures`
- `GET /research/framework/runs/{run_id}`
- `GET /research/framework/runs/{run_id}/{artifact_path}`

Requests are validated. Run identifiers and artifact paths are constrained, and
only declared derived files can be downloaded.

## Verification

```powershell
python -m unittest backend.test_research_framework backend.test_research_studio
cd frontend
npm run build
```

The generalized framework test uses synthetic Parquet data to verify arbitrary
variable roles, robust diagnostics, relationships, map layers, isolated exports,
and the guarantee that source data remain present and unmodified.
