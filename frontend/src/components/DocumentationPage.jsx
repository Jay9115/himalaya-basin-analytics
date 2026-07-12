import React from 'react';
import './DocumentationPage.css';

const sections = [
  { id: 'doc-context', title: '1. Project Context and ISRO SAC Relevance' },
  { id: 'doc-overview', title: '2. System Overview' },
  { id: 'doc-sources', title: '3. Data Sources and Provenance' },
  { id: 'doc-preprocessing', title: '4. Data Preparation and Storage' },
  { id: 'doc-runtime', title: '5. Runtime Loading and Performance' },
  { id: 'doc-map', title: '6. Spatial Visualization Method' },
  { id: 'doc-analytics', title: '7. Time Series, Region, and Hotspot Analysis' },
  { id: 'doc-api', title: '8. API and Filtering Logic' },
  { id: 'doc-science-use', title: '9. Scientific Interpretation Guide' },
  { id: 'doc-limitations', title: '10. Assumptions and Limitations' },
  { id: 'doc-repro', title: '11. Reproducibility Checklist' },
  { id: 'doc-references', title: '12. Reference Sources' },
];

const sourceRows = [
  {
    source: 'ISRO SAC',
    role: 'Institutional and scientific context',
    use: 'Remote sensing, GIS, hydrology, cryosphere, and environmental applications.',
    link: 'https://www.sac.gov.in/',
  },
  {
    source: 'NASA Earthdata',
    role: 'Discovery and access portal',
    use: 'Dataset discovery, metadata review, and Earth science archive navigation.',
    link: 'https://www.earthdata.nasa.gov/',
  },
  {
    source: 'Earthdata Search',
    role: 'Search and spatial filtering',
    use: 'Find NASA products by date, place, and collection before processing.',
    link: 'https://search.earthdata.nasa.gov/',
  },
  {
    source: 'Google Earth Engine',
    role: 'Cloud geospatial processing',
    use: 'Sampling, reprojection, export scripting, and grid-alignment workflows.',
    link: 'https://earthengine.google.com/',
  },
  {
    source: 'Copernicus ERA5-Land',
    role: 'Land reanalysis dataset',
    use: 'Historical hydro-climatic variables for basin-scale analysis.',
    link: 'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land',
  },
  {
    source: 'NSIDC MOD10A1',
    role: 'Snow cover and albedo product',
    use: 'Daily snow cover, snow albedo, and QA bands at 500 m resolution.',
    link: 'https://nsidc.org/data/mod10a1/versions/61',
  },
  {
    source: 'NASA SRTM',
    role: 'Elevation reference',
    use: 'Topographic support data for terrain-aware sampling and visualization.',
    link: 'https://www.earthdata.nasa.gov/data/instruments/srtm',
  },
  {
    source: 'Project glacier / basin assets',
    role: 'Vector boundaries',
    use: 'Basin masks, glacier overlays, and subregion selection in the app.',
    link: 'Local project assets',
  },
];

const endpointRows = [
  ['GET /datasets', 'List available datasets', 'none'],
  ['GET /years', 'List the years available for the selected dataset', 'dataset'],
  ['GET /dates', 'Build the date index for a chosen dataset and year range', 'dataset, year_start, year_end'],
  ['GET /variables', 'Return variables that exist in the selected scope', 'dataset, year_start, year_end'],
  ['GET /elevation-range', 'Find the valid elevation envelope for the selected scope', 'dataset, year_start, year_end'],
  ['GET /data', 'Return map-ready points for one date', 'date, elevation band, variable, dataset, year window, region'],
  ['GET /basin-mean', 'Compute a basin-wide time series', 'date range, elevation, variable, dataset, year window, region'],
  ['GET /region-mean', 'Compute a region-wise time series', 'year, lat/lon bounds, elevation, variable, dataset, year window, region'],
  ['GET /stats', 'Return scope-level diagnostics', 'dataset, year window'],
  ['GET /subregions', 'List basin subregions and glacier entries', 'include_glaciers'],
  ['GET /subregions/{id}/geometry', 'Fetch geometry for a selected subregion', 'subregion id'],
  ['GET /glaciers/search', 'Search glacier names and identifiers', 'q, limit'],
  ['GET /glaciers/overview', 'Return glacier polygons for the current map view', 'bbox, zoom'],
  ['GET /hotspot-trends', 'Compute long-term change hotspots', 'variable, elevation band, dataset, year window, min_years'],
  ['POST /nc/upload', 'Upload NetCDF and convert it into an app-compatible dataset', 'file, dataset_name'],
  ['GET /outcomes', 'List precomputed outcome modules', 'none'],
  ['GET /outcomes/long-term-hotspot/meta', 'Describe the long-term hotspot output bundle', 'none'],
  ['GET /outcomes/long-term-hotspot/data', 'Load precomputed long-term band means', 'variable, band_id'],
];

const referenceLinks = [
  {
    label: 'Space Applications Centre (SAC) - ISRO',
    url: 'https://www.sac.gov.in/',
    note: 'Official SAC overview and institutional context.',
  },
  {
    label: 'NASA Earthdata',
    url: 'https://www.earthdata.nasa.gov/',
    note: 'NASA Earth observation data discovery and access portal.',
  },
  {
    label: 'Earthdata Search',
    url: 'https://search.earthdata.nasa.gov/',
    note: 'Search NASA collections by date and spatial area.',
  },
  {
    label: 'Google Earth Engine',
    url: 'https://earthengine.google.com/',
    note: 'Cloud geospatial processing and planetary-scale analysis platform.',
  },
  {
    label: 'Copernicus ERA5-Land',
    url: 'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land',
    note: 'Land reanalysis dataset used for hydro-climatic inputs.',
  },
  {
    label: 'NSIDC MOD10A1',
    url: 'https://nsidc.org/data/mod10a1/versions/61',
    note: 'Daily snow cover and albedo product used for snow analysis.',
  },
  {
    label: 'NASA SRTM',
    url: 'https://www.earthdata.nasa.gov/data/instruments/srtm',
    note: 'Global elevation reference for topographic context.',
  },
];

function ExternalLink({ href, children }) {
  return (
    <a className="docs-inline-link" href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

function InfoCard({ label, value, detail }) {
  return (
    <div className="docs-summary-card">
      <div className="docs-summary-label">{label}</div>
      <div className="docs-summary-value">{value}</div>
      <div className="docs-summary-detail">{detail}</div>
    </div>
  );
}

function DocumentationPage({ selectedDataset, selectedYearRange, selectedVariable, stats }) {
  const datasetLabel = selectedDataset?.label || 'Dataset selected at runtime';
  const yearRangeText = selectedYearRange
    ? `${selectedYearRange.start} to ${selectedYearRange.end}`
    : 'User-selected at startup';
  const variableText = selectedVariable || 'User-selected variable';
  const quickFacts = [
    {
      label: 'Institutional focus',
      value: 'ISRO SAC',
      detail: "The project aligns with SAC's remote sensing and geospatial application work for societal benefit.",
    },
    {
      label: 'Primary inputs',
      value: 'ERA5-Land + CMIP6',
      detail: 'Historical land reanalysis and future climate projections for Himalayan basin analysis.',
    },
    {
      label: 'Supplementary data',
      value: 'NASA Earthdata + Earth Engine',
      detail: 'Used for dataset discovery, elevation support, snow products, and preprocessing exports.',
    },
    {
      label: 'Outputs',
      value: 'Maps + graphs + hotspots',
      detail: 'Daily map views, basin and region means, glacier analysis, and long-term trend layers.',
    },
  ];

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
          <div className="docs-hero-copy">
            <p className="docs-hero-kicker">ISRO SAC internship documentation</p>
            <h1>Scientific Methods and Implementation Notes</h1>
            <p>
              This page explains how the Himalayan Basin Analytics WebApp turns large climate,
              snow, glacier, elevation, and model datasets into an interactive local analysis
              workflow for research and internship reporting.
            </p>
            <p>
              The documentation is intentionally detailed so the report reflects the real scope
              of the work: ISRO SAC context, NASA Earthdata and Google Earth Engine sourcing,
              preprocessing, map rendering, hotspot analysis, and offline deployment.
            </p>
          </div>

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

          <div className="docs-summary-grid">
            {quickFacts.map((item) => (
              <InfoCard
                key={item.label}
                label={item.label}
                value={item.value}
                detail={item.detail}
              />
            ))}
          </div>
        </section>

        <section id="doc-context">
          <h2>1. Project Context and ISRO SAC Relevance</h2>
          <p>
            Space Applications Centre (SAC), Ahmedabad is one of the major centres of ISRO and
            focuses on the design of space-borne instruments and the development of space
            technology applications for societal benefit. The centre's public mission includes
            communication, broadcasting, navigation, disaster monitoring, meteorology,
            oceanography, environment monitoring, and natural resources survey.
          </p>
          <p>
            The internship project fits that mission naturally because it transforms spatial
            climate and cryosphere data into a usable geospatial analysis environment. Instead of
            keeping the data in disconnected CSV, raster, or NetCDF files, the WebApp provides a
            common viewing layer where basin patterns, glacier boundaries, elevation filters, and
            time-series summaries can be explored quickly.
          </p>
          <div className="docs-callout">
            <div className="docs-callout-title">Why this matters at SAC</div>
            <p>
              The value of the project is not only software convenience. It reduces repeated
              manual data wrangling, makes satellite and reanalysis products easier to inspect,
              and supports the type of remote-sensing and GIS work that SAC is known for.
            </p>
          </div>
          <ul>
            <li>SAC is a major ISRO R and D centre with strong ties to earth observation and geoscience workflows.</li>
            <li>The project supports basin-scale studies that are useful in hydrology, snow, glacier, and climate analysis.</li>
            <li>The app is designed to help researchers compare multiple data sources without opening every raw file manually.</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-overview">
          <h2>2. System Overview</h2>
          <p>
            The platform is a local-first geospatial analytics tool for Himalayan basin climate
            and hydro-meteorological analysis. It combines a FastAPI backend with a React,
            Deck.GL, and MapLibre frontend so that filtering, aggregation, and visualization stay
            responsive even when the underlying datasets are large.
          </p>
          <div className="docs-callout">
            <div className="docs-callout-title">Core design idea</div>
            <p>
              The backend does the heavy scientific work, the frontend does the interaction and
              rendering, and the storage layer keeps the runtime lightweight by serving only the
              files that are needed for the active dataset and year window.
            </p>
          </div>
          <ol>
            <li>User selects a dataset, year range, variable, and elevation band.</li>
            <li>The backend indexes only the selected scope and returns filtered responses.</li>
            <li>The frontend renders the map, legend, time slider, graph, and region overlays.</li>
            <li>Long-term hotspot mode uses the full selected year window to compute trend intensity.</li>
          </ol>
          <ul>
            <li>Backend responsibility: indexing, filtering, aggregation, and API responses.</li>
            <li>Frontend responsibility: map rendering, legend generation, time navigation, region selection, and UI interaction.</li>
            <li>Execution mode: analytics runs locally by default, with optional packaged offline deployment.</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-sources">
          <h2>3. Data Sources and Provenance</h2>
          <p>
            The app uses a layered data stack. Some data are obtained from public science portals
            such as NASA Earthdata and Copernicus, some are prepared in Google Earth Engine, and
            some are maintained as local project assets for basin boundaries, glacier polygons,
            and analysis outputs.
          </p>
          <p>
            In practice, Earthdata was used for discovery and metadata review, while Earth Engine
            was used for scripted preprocessing, sampling, and export workflows. The runtime app
            then consumes the prepared outputs locally.
          </p>

          <table className="docs-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Role</th>
                <th>How it is used</th>
                <th>Official link</th>
              </tr>
            </thead>
            <tbody>
              {sourceRows.map((row) => (
                <tr key={row.source}>
                  <td>{row.source}</td>
                  <td>{row.role}</td>
                  <td>{row.use}</td>
                  <td>
                    {row.link === 'Local project assets' ? (
                      row.link
                    ) : (
                      <ExternalLink href={row.link}>Open source</ExternalLink>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>3.1 Key data classes used in the app</h3>
          <ul>
            <li>ERA5-Land for historical land reanalysis variables such as temperature, precipitation, snowfall, snow depth, SWE, solar radiation, and wind speed.</li>
            <li>CMIP6 and NEX-GDDP-CMIP6 for future climate projections and scenario comparison.</li>
            <li>MOD10A1 snow cover and albedo for satellite-based snow analysis.</li>
            <li>SRTM elevation for terrain-aware interpretation and map context.</li>
            <li>Glacier and basin polygons for spatial filtering and regional comparison.</li>
            <li>User-uploaded NetCDF files for additional exploratory datasets.</li>
          </ul>

          <h3>3.2 Why Earthdata and Earth Engine matter here</h3>
          <p>
            NASA Earthdata acts as the discovery layer for Earth observation products, while
            Google Earth Engine acts as the processing layer that can sample, reproject, and
            export geospatial data at scale. That pairing is important for mountain basin work
            because the source datasets are not just large, they are also mixed in format and
            spatial resolution.
          </p>
          <p>
            For this internship, that meant a practical workflow where elevation and snow products
            could be reviewed from NASA sources, then aligned to the target climate grid through
            Earth Engine export scripts before the application consumed them in parquet or raster
            form.
          </p>

          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-preprocessing">
          <h2>4. Data Preparation and Storage</h2>
          <p>
            The preprocessing pipeline converts large raw files into a format that the app can
            query quickly. The main strategy is to avoid repeated heavy parsing at runtime and to
            make the data easier to filter by date, variable, elevation, and region.
          </p>
          <h3>4.1 Conversion strategy</h3>
          <ol>
            <li>Raw yearly CSV files are exported from Google Earth Engine with date, lat/lon, elevation, and climate variables.</li>
            <li>CSV files are converted to parquet using chunked reading and Snappy compression for fast local IO.</li>
            <li>Date parsing is strict, so invalid strings are rejected instead of being silently coerced.</li>
            <li>Numeric columns are auto-cast only when the values are consistently numeric.</li>
            <li>Geometry and system columns such as <code>.geo</code> and <code>system:index</code> are excluded from runtime analytics columns.</li>
          </ol>

          <h3>4.2 Grid alignment and unit handling</h3>
          <p>
            Earth Engine export scripts explicitly align DEM and climate pixels before sampling.
            That means the elevation layer is reprojected to the target grid before it is joined
            with climate variables. This keeps the terrain context consistent within each dataset.
          </p>
          <table className="docs-table">
            <thead>
              <tr>
                <th>Dataset</th>
                <th>Target grid source</th>
                <th>DEM alignment method</th>
                <th>Sampling scale</th>
                <th>Output notes</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>ERA5-Land</td>
                <td><code>era5Land.first().projection()</code></td>
                <td><code>resample('bilinear')</code> + <code>reproject(..., scale: 11000)</code></td>
                <td>11,000 m</td>
                <td>Coordinates derived from pixel lon/lat bands, geometry usually removed in export.</td>
              </tr>
              <tr>
                <td>CMIP6</td>
                <td><code>cmip6.first().projection()</code></td>
                <td><code>resample('bilinear')</code> + <code>reproject(..., scale: 25000)</code></td>
                <td>25,000 m</td>
                <td>Geometries may be used during extraction and later removed in exported fields.</td>
              </tr>
            </tbody>
          </table>

          <h3>4.3 Representative conversions</h3>
          <table className="docs-table">
            <thead>
              <tr>
                <th>Variable in app</th>
                <th>Derived from</th>
                <th>Conversion</th>
                <th>Final unit</th>
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
              <tr><td>temp_mean_C</td><td>tas</td><td>K - 273.15</td><td>deg C</td></tr>
              <tr><td>temp_max_C</td><td>tasmax</td><td>K - 273.15</td><td>deg C</td></tr>
              <tr><td>temp_min_C</td><td>tasmin</td><td>K - 273.15</td><td>deg C</td></tr>
              <tr><td>precip_mm_day</td><td>pr</td><td>x 86400</td><td>mm/day</td></tr>
              <tr><td>solar_MJm2_day</td><td>rsds</td><td>x 0.0864</td><td>MJ/m2/day</td></tr>
            </tbody>
          </table>

          <p>
            Practical implication: ERA5-Land and CMIP6 outputs are internally consistent with
            their own native analysis scales, but they are not on the same spatial resolution.
            Any cross-dataset comparison should mention that difference explicitly.
          </p>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-runtime">
          <h2>5. Runtime Loading and Performance</h2>
          <p>
            The runtime design keeps the user experience responsive by loading only the data that
            is necessary for the current dataset, date, year window, variable, and elevation band.
            That approach matters because the underlying Himalayan data files can be large.
          </p>
          <ul>
            <li>User first selects dataset and year range on the home screen.</li>
            <li>Backend filters files by year tokens in the filename and then by parsed date values.</li>
            <li>If a filename has no detectable year token, it is still considered during indexing.</li>
            <li>Backend keeps a small index cache by year-window key for fast switching.</li>
            <li>Parquet reads use projected columns and filter predicates to minimize memory and IO.</li>
            <li>Frontend cancels stale requests during slider changes to avoid unnecessary work.</li>
            <li>Responses are compressed when payloads are large.</li>
          </ul>
          <div className="docs-callout">
            <div className="docs-callout-title">Performance principle</div>
            <p>
              The app does not try to move every point to the browser at once. It asks the backend
              for only the currently relevant subset, which is the main reason the dashboard stays
              usable for research-sized datasets.
            </p>
          </div>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-map">
          <h2>6. Spatial Visualization Method</h2>
          <h3>6.1 Layer stack</h3>
          <ol>
            <li>Base map style with light or dark theme support.</li>
            <li>India PMTiles vector boundaries and labels where glyphs are available.</li>
            <li>Basin polygon overlay.</li>
            <li>Selected glacier or subregion boundary overlay.</li>
            <li>Data points rendered with Deck.GL scatter symbols.</li>
            <li>Selection rectangle or manual region overlay.</li>
          </ol>

          <h3>6.2 Color classification</h3>
          <p>
            For the currently loaded day and filters, the app computes data minimum and maximum
            values and then splits them into equal-interval bins. The legend is therefore dynamic
            and relative to the current view, not a fixed climatology scale.
          </p>
          <pre className="docs-code">{`p20 = min + 0.2 * (max - min)
p40 = min + 0.4 * (max - min)
p60 = min + 0.6 * (max - min)
p80 = min + 0.8 * (max - min)`}</pre>
          <p>
            Colors move from blue for lower values to red for higher values. If all values are
            identical in a view, the app uses a fallback single-color behavior.
          </p>

          <h3>6.3 Map geometry behavior</h3>
          <ul>
            <li>Point positions use stored lon/lat directly, so there is no interpolation on the map.</li>
            <li>Point radius is fixed in map units for visual consistency during navigation.</li>
            <li>Theme changes affect both UI styling and the basemap style.</li>
            <li>Glacier mode helps separate glacier-specific interpretation from basin-wide analysis.</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-analytics">
          <h2>7. Time Series, Region, and Hotspot Analysis</h2>
          <h3>7.1 Basin mean graph</h3>
          <p>
            In basin mode, the backend groups all points inside the selected year range and
            elevation band and computes a daily mean for each date. This provides a compact view
            of basin-scale temporal behavior for the selected variable.
          </p>
          <h3>7.2 Region mean graph</h3>
          <p>
            If a rectangle or subregion is selected, the graph is recomputed only for points that
            satisfy the spatial bounds and elevation filter. This is useful for comparing local
            behavior across glacier-fed areas or smaller hydrological units.
          </p>
          <h3>7.3 Temporal navigation</h3>
          <ul>
            <li>Play and Pause animate the selected date sequence one frame at a time.</li>
            <li>The date slider and date input let the user jump to a specific day.</li>
            <li>Graph cut mode uses two clicks to create a time zoom window.</li>
            <li>Only one variable is active at a time, so comparisons stay controlled.</li>
          </ul>
          <h3>7.4 Hotspot mode and long-term outcomes</h3>
          <p>
            Hotspot mode uses the full selected year window to fit trends at each grid point. The
            app computes the trend slope, summarizes overall strength, and classifies locations
            using percentile thresholds such as P70, P85, and P95.
          </p>
          <pre className="docs-code">{`Y = aX + b

Y = annual mean value
X = year
a = trend slope
b = intercept`}</pre>
          <p>
            The minimum yearly coverage setting is important because it keeps the trend estimate
            meaningful by excluding points with too few annual observations.
          </p>
          <div className="docs-callout">
            <div className="docs-callout-title">Interpretation note</div>
            <p>
              Hotspot mode shows trend intensity, not a daily anomaly map. The time slider still
              moves the graph marker, but the trend computation itself uses the full selected year
              window.
            </p>
          </div>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-api">
          <h2>8. API and Filtering Logic</h2>
          <p>
            The API is intentionally small and focused on the operations needed by the app:
            discover the dataset, build the available year and date scope, filter by elevation and
            spatial region, and return either map points or aggregated time-series values.
          </p>
          <table className="docs-table">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Purpose</th>
                <th>Main filters</th>
              </tr>
            </thead>
            <tbody>
              {endpointRows.map(([endpoint, purpose, filters]) => (
                <tr key={endpoint}>
                  <td>{endpoint}</td>
                  <td>{purpose}</td>
                  <td>{filters}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            The filtering order is important. The backend first narrows the dataset and year
            range, then applies date and elevation filters, and finally applies the selected
            region or glacier geometry if one is present. That keeps the response smaller and
            reduces unnecessary processing.
          </p>
          <p>
            Elevation is clamped to app-defined bounds, and invalid ranges are rejected before
            the query runs. This prevents silent errors and keeps the UI predictable.
          </p>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-science-use">
          <h2>9. Scientific Interpretation Guide</h2>
          <ul>
            <li>Use basin mode for domain-scale temporal behavior under a chosen elevation range.</li>
            <li>Use region mode for local anomaly checks, glacier comparison, and sub-basin study.</li>
            <li>Compare only like with like: same variable, same dataset family, and the same year window.</li>
            <li>Report whether a result comes from ERA5-Land reanalysis, CMIP6 scenario data, MOD10A1 snow products, or user-uploaded NetCDF.</li>
            <li>Use point count as confidence context because low counts can indicate sparse valid cells under tight filters.</li>
            <li>Document the selected spatial filter, elevation band, and year range in any scientific write-up.</li>
          </ul>
          <div className="docs-callout">
            <div className="docs-callout-title">Good reporting habit</div>
            <p>
              Whenever results are shared, the data source should be stated clearly. For example,
              mention whether the figure comes from NASA Earthdata-derived SRTM, Earth Engine
              processed MOD10A1, Copernicus ERA5-Land, or CMIP6 scenario data.
            </p>
          </div>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-limitations">
          <h2>10. Assumptions and Limitations</h2>
          <ul>
            <li>Daily means are arithmetic means across selected points; area-weighted averaging is not currently applied.</li>
            <li>Color bins are dynamic by current filtered extent, so two days may not use the same absolute thresholds.</li>
            <li>Outputs depend on source dataset resolution and the preprocessing choices made in Earth Engine or the local converter.</li>
            <li>Some annual files can have fewer than 365 records because of source calendar behavior or export structure.</li>
            <li>Dense raster map responses may be capped for browser smoothness, which affects display density but not the raw source file.</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-repro">
          <h2>11. Reproducibility Checklist</h2>
          <ol>
            <li>Record dataset name, variable, year range, elevation range, and region bounds used in the analysis.</li>
            <li>Store the exact parquet file set and app version used for the run.</li>
            <li>Keep the Earth Engine export script version and unit conversion factors for audit trail purposes.</li>
            <li>Verify units before cross-dataset comparison.</li>
            <li>When publishing results, state whether values come from ERA5-Land, CMIP6, MOD10A1, or a user-uploaded NetCDF file.</li>
            <li>Keep the selected glacier or basin geometry name in the project notes if spatial filtering was used.</li>
          </ol>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-references">
          <h2>12. Reference Sources</h2>
          <p>
            The following official sources are the most relevant references for the data and
            platform context used in this app.
          </p>
          <table className="docs-table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Why it matters</th>
                <th>Link</th>
              </tr>
            </thead>
            <tbody>
              {referenceLinks.map((row) => (
                <tr key={row.label}>
                  <td>{row.label}</td>
                  <td>{row.note}</td>
                  <td>
                    <ExternalLink href={row.url}>Open</ExternalLink>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            For the working implementation, the most useful internal reference is the app itself:
            the backend routes in <code>backend/main.py</code>, the client calls in
            <code>frontend/src/services/api.js</code>, and the dashboard logic in
            <code>frontend/src/App.jsx</code>.
          </p>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>
      </article>
    </div>
  );
}

export default React.memo(DocumentationPage);
