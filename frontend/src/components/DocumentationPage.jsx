import React from 'react';
import './DocumentationPage.css';

const sections = [
  { id: 'doc-overview', title: '1. System Overview' },
  { id: 'doc-data', title: '2. Data Sources and Units' },
  { id: 'doc-preprocessing', title: '3. Preprocessing Pipeline' },
  { id: 'doc-runtime', title: '4. Runtime Loading and Performance' },
  { id: 'doc-map', title: '5. Spatial Visualization Method' },
  { id: 'doc-timeseries', title: '6. Time Series and Graph Method' },
  { id: 'doc-region', title: '7. Region Selection Method' },
  { id: 'doc-formulas', title: '8. Core Equations' },
  { id: 'doc-api', title: '9. API and Filtering Logic' },
  { id: 'doc-science-use', title: '10. Scientific Interpretation Guide' },
  { id: 'doc-limitations', title: '11. Assumptions and Limitations' },
  { id: 'doc-repro', title: '12. Reproducibility Checklist' },
];

function DocumentationPage({ selectedDataset, selectedYearRange, selectedVariable, stats }) {
  const datasetLabel = selectedDataset?.label || 'Dataset selected at runtime';
  const yearRangeText = selectedYearRange
    ? `${selectedYearRange.start} to ${selectedYearRange.end}`
    : 'User-selected at startup';
  const variableText = selectedVariable || 'User-selected variable';

  return (
    <div className="docs-page" id="doc-top">
      <aside className="docs-toc">
        <h3>Chapters</h3>
        <nav>
          {sections.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              {section.title}
            </a>
          ))}
        </nav>
      </aside>

      <article className="docs-content">
        <section className="docs-hero">
          <h1>Scientific Methods and Implementation Notes</h1>
          <p>
            This page documents the computational logic used in the webapp, including
            data provenance, transformations, map rendering rules, temporal aggregation,
            and known assumptions.
          </p>
          <div className="docs-context">
            <div><strong>Current Dataset:</strong> {datasetLabel}</div>
            <div><strong>Current Year Window:</strong> {yearRangeText}</div>
            <div><strong>Current Variable:</strong> {variableText}</div>
            {stats && (
              <div>
                <strong>Indexed Scope:</strong> {stats.total_dates} dates, {stats.total_files} files, {stats.total_size_mb} MB
              </div>
            )}
          </div>
        </section>

        <section id="doc-overview">
          <h2>1. System Overview</h2>
          <p>
            The platform is a local-first geospatial analytics tool for Himalayan basin climate and hydro-meteorological analysis.
            It combines a FastAPI backend with a React + Deck.GL + MapLibre frontend.
          </p>
          <ul>
            <li>Backend responsibility: indexed parquet loading, filtering, aggregation, and API responses.</li>
            <li>Frontend responsibility: map rendering, legend generation, time navigation, region selection, and UI interaction.</li>
            <li>Execution mode: analytics pipeline runs fully local (backend + parquet + map overlays). Optional environment overrides can still point to custom external style URLs if desired.</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-data">
          <h2>2. Data Sources and Units</h2>
          <p>The application currently supports ERA5 and CMIP6 daily gridded datasets for the basin domain.</p>
          <p>
            CMIP6 export script currently targets model <strong>GFDL-ESM4</strong> and scenario <strong>SSP2-4.5 (ssp245)</strong>,
            unless changed before export.
          </p>
          <h3>2.1 ERA5-Land (from GEE export script)</h3>
          <table className="docs-table">
            <thead>
              <tr>
                <th>Variable in App</th>
                <th>Derived From</th>
                <th>Conversion</th>
                <th>Final Unit</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>temperature_C</td><td>temperature_2m</td><td>K - 273.15</td><td>deg C</td></tr>
              <tr><td>SWE_mm</td><td>snow_depth_water_equivalent</td><td>x 1000</td><td>mm</td></tr>
              <tr><td>snow_depth_mm</td><td>snow_depth</td><td>x 1000</td><td>mm</td></tr>
              <tr><td>snowfall_mm</td><td>snowfall_sum</td><td>x 1000</td><td>mm/day equivalent</td></tr>
              <tr><td>precipitation_mm</td><td>total_precipitation_sum</td><td>x 1000</td><td>mm/day equivalent</td></tr>
              <tr><td>solar_radiation_MJm2</td><td>surface_solar_radiation_downwards_sum</td><td>/ 1e6</td><td>MJ/m2/day</td></tr>
              <tr><td>wind_speed_ms</td><td>u10, v10</td><td>sqrt(u^2 + v^2)</td><td>m/s</td></tr>
            </tbody>
          </table>

          <h3>2.2 CMIP6 (from GEE export script)</h3>
          <table className="docs-table">
            <thead>
              <tr>
                <th>Variable in App</th>
                <th>Derived From</th>
                <th>Conversion</th>
                <th>Final Unit</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>temp_mean_C</td><td>tas</td><td>K - 273.15</td><td>deg C</td></tr>
              <tr><td>temp_max_C</td><td>tasmax</td><td>K - 273.15</td><td>deg C</td></tr>
              <tr><td>temp_min_C</td><td>tasmin</td><td>K - 273.15</td><td>deg C</td></tr>
              <tr><td>precip_mm_day</td><td>pr</td><td>x 86400</td><td>mm/day</td></tr>
              <tr><td>solar_MJm2_day</td><td>rsds</td><td>x 0.0864</td><td>MJ/m2/day</td></tr>
              <tr><td>wind_speed_ms</td><td>sfcWind</td><td>direct</td><td>m/s</td></tr>
            </tbody>
          </table>

          <p>
            Elevation is sampled from SRTM DEM after reprojection to each data grid (ERA5 scale ~11 km, CMIP6 scale ~25 km in the export scripts).
          </p>

          <h3>2.3 GEE Export Resolution and Grid Alignment Method</h3>
          <p>
            The export scripts explicitly align DEM and climate pixels before sampling, so elevation and climate values are extracted on a
            consistent grid in each dataset.
          </p>
          <table className="docs-table">
            <thead>
              <tr>
                <th>Dataset</th>
                <th>Target Grid Source</th>
                <th>DEM Alignment Method</th>
                <th>Sampling Scale</th>
                <th>Sampling Geometry Handling</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>ERA5-Land</td>
                <td><code>era5Land.first().projection()</code></td>
                <td><code>resample('bilinear')</code> + <code>reproject(..., scale: 11000)</code></td>
                <td>11,000 m</td>
                <td><code>geometries: false</code>, coordinates from <code>pixelLonLat()</code> bands</td>
              </tr>
              <tr>
                <td>CMIP6</td>
                <td><code>cmip6.first().projection()</code></td>
                <td><code>resample('bilinear')</code> + <code>reproject(..., scale: 25000)</code></td>
                <td>25,000 m</td>
                <td><code>geometries: true</code> for extraction, then geometry removed in exported fields</td>
              </tr>
            </tbody>
          </table>
          <ul>
            <li><strong>Bilinear interpolation</strong> is used to align SRTM elevation to the target climate grid.</li>
            <li><strong>Region mask</strong> is applied using basin geometry during sampling.</li>
            <li><strong>tileScale = 4</strong> is used in GEE sample step to reduce memory pressure during export tasks.</li>
            <li><strong>Coordinate precision</strong> is reduced to 4 decimals in export scripts for compact files and stable joins.</li>
          </ul>
          <pre className="docs-code">{`ERA5 alignment:
dem_aligned = SRTM.resample('bilinear').reproject(crs=ERA5_projection, scale=11000)
samples = (ERA5_variables + dem_aligned + pixelLonLat).sample(region=basin, scale=11000)

CMIP6 alignment:
dem_aligned = SRTM.resample('bilinear').reproject(crs=CMIP6_projection, scale=25000)
samples = (CMIP6_variables + dem_aligned).sample(region=basin, scale=25000)`}</pre>
          <p>
            Practical implication: ERA5 and CMIP6 outputs are each internally consistent with their own native analysis scale, but they are
            not on identical spatial resolution. Direct cross-dataset comparison should always report this scale difference.
          </p>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-preprocessing">
          <h2>3. Preprocessing Pipeline</h2>
          <ol>
            <li>Raw yearly CSV files are exported from GEE with date, lat/lon, elevation, and climate variables.</li>
            <li>CSV files are converted to parquet using chunked reading and Snappy compression for fast local IO.</li>
            <li>Date parsing is strict (invalid strings are rejected, not silently coerced).</li>
            <li>Numeric columns are auto-cast only when all non-null values are numeric.</li>
            <li>Geometry/system columns (for example `.geo`, `system:index`) are excluded from runtime analytics columns.</li>
          </ol>
          <p>
            Important: the year loops shown in GEE scripts are examples for export batching. Runtime year filtering is now controlled by user-selected year range in the app.
          </p>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-runtime">
          <h2>4. Runtime Loading and Performance</h2>
          <ul>
            <li>User first selects dataset and year range on the home screen.</li>
            <li>Backend first filters files by year tokens in filename, then filters by parsed date values while indexing.</li>
            <li>If a filename has no detectable year token, that file is still considered and filtered by dates during indexing.</li>
            <li>Backend keeps a small index cache by year-window key for fast switching.</li>
            <li>Parquet reads use projected columns + filter predicates to minimize memory and IO.</li>
            <li>Frontend cancels stale requests during slider/filter changes to avoid unnecessary workload.</li>
            <li>Responses are gzip-compressed when payload is large.</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-map">
          <h2>5. Spatial Visualization Method</h2>
          <h3>5.1 Layer stack</h3>
          <ol>
            <li>Base map style (offline light/dark background style by default).</li>
            <li>India PMTiles vector boundaries (and labels when glyphs are available in map style).</li>
            <li>Basin polygon overlay.</li>
            <li>Data points as Deck.GL scatter symbols.</li>
          </ol>

          <h3>5.2 Color classification</h3>
          <p>
            For the currently loaded day and filters, the app computes data min and max, then splits into equal-interval bins:
            [0-20%), [20-40%), [40-60%), [60-80%), [80-100%].
            This is a relative scale per current view/filter (not a global fixed climatology palette).
          </p>
          <pre className="docs-code">{`p20 = min + 0.2 * (max - min)
p40 = min + 0.4 * (max - min)
p60 = min + 0.6 * (max - min)
p80 = min + 0.8 * (max - min)`}</pre>
          <p>
            Colors are assigned from blue (lowest) to red (highest). Legend thresholds are generated from these same cut points.
            If all values are identical on a view, the app uses a single fallback color behavior.
          </p>

          <h3>5.3 Map geometry behavior</h3>
          <ul>
            <li>Point positions use stored lon/lat directly (no interpolation).</li>
            <li>Point radius is fixed in map units for visual consistency during navigation.</li>
            <li>Theme switch affects both UI and basemap style.</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-timeseries">
          <h2>6. Time Series and Graph Method</h2>
          <h3>6.1 Basin mean graph (default mode)</h3>
          <p>
            For each date in selected year range, all points inside selected elevation band are aggregated to daily mean and point count.
          </p>
          <h3>6.2 Region mean graph (rectangle mode)</h3>
          <p>
            If a region is selected, daily mean is computed only for points inside rectangle bounds and elevation filter, for a chosen year.
          </p>
          <h3>6.3 Temporal navigation</h3>
          <ul>
            <li>Play/Pause animates day-by-day at selected speed.</li>
            <li>Date slider and date input jump to specific date index.</li>
            <li>Graph cut mode creates zoom window between two clicked dates; this is visual filtering of loaded graph data.</li>
            <li>Only one variable is active at a time (checkbox list behaves as single-select).</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-region">
          <h2>7. Region Selection Method</h2>
          <ul>
            <li>User can draw a rectangle directly on map or enter lat/lon bounds manually.</li>
            <li>Map pixel coordinates are unprojected into lon/lat using active viewport transform.</li>
            <li>Selected rectangle persists on map until cleared.</li>
            <li>Region summary graph reports daily mean and point counts for that region-year selection.</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-formulas">
          <h2>8. Core Equations</h2>
          <h3>8.1 Wind speed reconstruction (ERA5)</h3>
          <pre className="docs-code">{`wind_speed_ms = sqrt(u10^2 + v10^2)`}</pre>

          <h3>8.2 Unit transformations</h3>
          <pre className="docs-code">{`temperature_C = temperature_K - 273.15
precip_mm_day (CMIP6) = pr_kg_m^-2_s^-1 * 86400
solar_MJm2_day (CMIP6) = rsds_W_m^-2 * 0.0864`}</pre>

          <h3>8.3 Basin daily mean</h3>
          <pre className="docs-code">{`Let S_t = set of points on day t after dataset/year/elevation filters
mu_t = (1 / |S_t|) * sum_{i in S_t} x_{i,t}
pixel_count_t = |S_t|`}</pre>

          <h3>8.4 Region daily mean</h3>
          <pre className="docs-code">{`Let R_t = set of points satisfying:
min_lat <= lat <= max_lat,
min_lon <= lon <= max_lon,
elev_min <= elev <= elev_max,
date = t

region_mean_t = (1 / |R_t|) * sum_{i in R_t} x_{i,t}`}</pre>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-api">
          <h2>9. API and Filtering Logic</h2>
          <table className="docs-table">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Purpose</th>
                <th>Main Filters</th>
              </tr>
            </thead>
            <tbody>
              <tr><td>/datasets</td><td>List available datasets</td><td>none</td></tr>
              <tr><td>/years</td><td>List available years from files</td><td>dataset</td></tr>
              <tr><td>/dates</td><td>Date index for selected scope</td><td>dataset, year_start, year_end</td></tr>
              <tr><td>/variables</td><td>Variable list</td><td>dataset, year_start, year_end</td></tr>
              <tr><td>/elevation-range</td><td>Elevation filter limits</td><td>dataset, year_start, year_end</td></tr>
              <tr><td>/data</td><td>Map points for one date</td><td>date, elevation band, variable, dataset, year window</td></tr>
              <tr><td>/basin-mean</td><td>Daily basin time series</td><td>date range, elevation, variable, dataset, year window</td></tr>
              <tr><td>/region-mean</td><td>Daily region time series</td><td>year, lat/lon bounds, elevation, variable, dataset, year window</td></tr>
              <tr><td>/stats</td><td>Scope-level diagnostics</td><td>dataset, year window</td></tr>
            </tbody>
          </table>
          <p>
            Elevation filter is clamped to fixed app bounds (500 m to 9000 m). Invalid ranges are rejected before query execution.
          </p>
          <p>
            Year listing is derived primarily from year tokens in parquet filenames, with date-index fallback if filename tokens are absent.
          </p>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-science-use">
          <h2>10. Scientific Interpretation Guide</h2>
          <ul>
            <li>Use basin mode for domain-scale temporal behavior under chosen elevation constraints.</li>
            <li>Use region mode for local anomaly checks and sub-basin comparison.</li>
            <li>Use same variable + same color limits strategy for visual comparison. Current legend is dynamic per view.</li>
            <li>Use point count as confidence context: lower count can indicate sparse valid cells under tight filters.</li>
            <li>Document dataset choice (ERA5 reanalysis vs CMIP6 scenario projections) in scientific reports.</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-limitations">
          <h2>11. Assumptions and Limitations</h2>
          <ul>
            <li>Daily means are arithmetic means across selected points; area-weighted averaging is not currently applied.</li>
            <li>Color bins are dynamic by current filtered extent; colors between two different days may not represent identical absolute thresholds.</li>
            <li>Outputs depend on source dataset resolution and preprocessing choices in GEE export scripts.</li>
            <li>Some annual files can have fewer than 365 records due source calendar/export behavior.</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-repro">
          <h2>12. Reproducibility Checklist</h2>
          <ol>
            <li>Record dataset name, variable, year range, elevation range, and region bounds used in analysis.</li>
            <li>Store exact parquet file set and app version used for run.</li>
            <li>Keep GEE export script version with conversion factors for audit trail.</li>
            <li>Verify units before cross-dataset comparison.</li>
            <li>When publishing results, report whether values come from ERA5 or CMIP6 scenario (model + SSP).</li>
          </ol>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>
      </article>
    </div>
  );
}

export default React.memo(DocumentationPage);
