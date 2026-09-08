import React from 'react';
import './DocumentationPage.css';

const sections = [
  { id: 'doc-context', title: '1. Project Context and ISRO SAC Relevance' },
  { id: 'doc-overview', title: '2. Workflow Modes and System Overview' },
  { id: 'doc-datasets', title: '3. Supported Datasets and Runtime Assets' },
  { id: 'doc-sources', title: '4. Data Sources and Provenance' },
  { id: 'doc-preprocessing', title: '5. Data Preparation and Storage' },
  { id: 'doc-runtime', title: '6. Runtime Loading and Performance' },
  { id: 'doc-map', title: '7. Spatial Visualization and Search Tools' },
  { id: 'doc-analytics', title: '8. Time Series, Region, and Trend Analysis' },
  { id: 'doc-outcomes', title: '9. Outcome Modules and Precomputed Products' },
  { id: 'doc-research', title: '10. General Research Toolkit' },
  { id: 'doc-advanced', title: '11. Custom Operations Workspace and Optional LLM Assistance' },
  { id: 'doc-api', title: '12. API Surface and Filtering Logic' },
  { id: 'doc-science-use', title: '13. Scientific Interpretation Guide' },
  { id: 'doc-limitations', title: '14. Assumptions, Limitations, and Reproducibility' },
  { id: 'doc-references', title: '15. Reference Sources' },
];

const workflowRows = [
  {
    module: 'Interactive Dashboard',
    purpose: 'Primary live analysis workspace.',
    notes: 'Supports dataset selection, date slider, elevation filters, basin and glacier search, map rendering, and graphs.',
  },
  {
    module: 'Outcomes',
    purpose: 'Fast review of saved scientific products.',
    notes: 'Currently hosts the Long Term Hotspot Analysis module with precomputed ERA5 band means and change layers.',
  },
  {
    module: 'Scientific Documentation',
    purpose: 'Methodology, implementation notes, and reporting context.',
    notes: 'Designed for internship reporting, reproducibility, and scientific explanation of the interface.',
  },
  {
    module: 'HB Code Workspace',
    purpose: 'Programmable analysis inside the dashboard.',
    notes: 'Uses a Monaco editor, backend code validation, inline execution for small selections, and queued jobs for large selections.',
  },
  {
    module: 'Research Toolkit',
    purpose: 'Guided, reproducible methods inside the live dashboard.',
    notes: 'Applies robust trends, anomalies, change detection, emergence, compound footprints, and cross-dataset relationships to arbitrary numeric variables.',
  },
  {
    module: 'HB Chatbot',
    purpose: 'Optional local guidance layer.',
    notes: 'Uses the separate local LLM service on port 8010 to answer questions or draft Python for the current dashboard context.',
  },
];

const datasetRows = [
  {
    dataset: 'ERA5 Full Shape',
    storage: 'Parquet',
    purpose: 'Historical hydro-climatic analysis across the Himalayan basin.',
    notes: 'Main source for daily map mode, basin means, hotspot trends, and the current outcome module.',
  },
  {
    dataset: 'CMIP6 Full Shape',
    storage: 'Parquet',
    purpose: 'Scenario-oriented future climate comparison.',
    notes: 'Useful for projected temperature, precipitation, and radiation variables under climate scenarios.',
  },
  {
    dataset: 'SPHY Model',
    storage: 'Parquet',
    purpose: 'Hydrological model output review.',
    notes: 'Handled through the same filtering pipeline as other parquet-backed datasets.',
  },
  {
    dataset: 'CHIRPS Precipitation',
    storage: 'Parquet',
    purpose: 'Rainfall-focused basin and region analysis.',
    notes: 'Prepared for fast precipitation exploration over long time ranges.',
  },
  {
    dataset: 'MOD10A1 Monthly Snow/Albedo',
    storage: 'GeoTIFF',
    purpose: 'Monthly snow and albedo overview.',
    notes: 'GeoTIFF-backed mode uses a fixed default elevation when a separate terrain grid is not stored per pixel in the runtime table.',
  },
  {
    dataset: 'Discharge Network',
    storage: 'GeoParquet',
    purpose: 'Network-style discharge exploration.',
    notes: 'Served through a GeoParquet path with the same date and variable validation surface.',
  },
  {
    dataset: 'Uploaded NetCDF Datasets',
    storage: 'Converted to Parquet',
    purpose: 'User-supplied exploratory datasets.',
    notes: 'Added through the upload workflow and then treated as reusable local datasets without modifying the built-in collections.',
  },
];

const sourceRows = [
  {
    source: 'ISRO SAC',
    role: 'Institutional and scientific context',
    use: 'Connects the work to remote sensing, GIS, hydrology, cryosphere, and environmental monitoring use cases.',
    link: 'https://www.sac.gov.in/',
  },
  {
    source: 'NASA Earthdata',
    role: 'Discovery and access portal',
    use: 'Used for product discovery, metadata review, and source selection for Earth observation inputs.',
    link: 'https://www.earthdata.nasa.gov/',
  },
  {
    source: 'Earthdata Search',
    role: 'Spatial and temporal search',
    use: 'Supports collection lookup by date, place, and science keyword before preprocessing.',
    link: 'https://search.earthdata.nasa.gov/',
  },
  {
    source: 'Google Earth Engine',
    role: 'Cloud geospatial processing',
    use: 'Used for export scripting, reprojection, sampling, and preparation of climate-ready tabular outputs.',
    link: 'https://earthengine.google.com/',
  },
  {
    source: 'Copernicus ERA5-Land',
    role: 'Historical land reanalysis',
    use: 'Provides many of the daily basin variables used for temperature, precipitation, snow, radiation, and wind analysis.',
    link: 'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land',
  },
  {
    source: 'CMIP6 / NEX-GDDP-CMIP6',
    role: 'Climate projection family',
    use: 'Supports future climate and scenario-oriented analysis in the same interface.',
    link: 'https://www.nccs.nasa.gov/services/data-collections/land-based-products/nex-gddp',
  },
  {
    source: 'NSIDC MOD10A1',
    role: 'Snow cover and albedo product',
    use: 'Provides monthly snow and albedo inputs through GeoTIFF-backed visualization.',
    link: 'https://nsidc.org/data/mod10a1/versions/61',
  },
  {
    source: 'CHIRPS',
    role: 'Precipitation dataset',
    use: 'Provides long-term rainfall fields prepared as parquet for quick regional graphing and mapping.',
    link: 'https://www.chc.ucsb.edu/data/chirps',
  },
  {
    source: 'NASA SRTM',
    role: 'Elevation reference',
    use: 'Provides topographic context for terrain-aware interpretation and preprocessing support.',
    link: 'https://www.earthdata.nasa.gov/data/instruments/srtm',
  },
  {
    source: 'Local glacier, basin, and map assets',
    role: 'Runtime vectors and base overlays',
    use: 'Provide basin boundaries, glacier lookups, PMTiles boundaries, and precomputed project outputs used directly by the app.',
    link: 'Local project assets',
  },
];

const endpointRows = [
  ['GET /datasets', 'List available runtime datasets and file counts', 'none'],
  ['GET /years', 'List the years available for the selected dataset', 'dataset'],
  ['GET /dates', 'Build the date index for a chosen dataset and year range', 'dataset, year_start, year_end'],
  ['GET /variables', 'Return variables that exist in the selected scope', 'dataset, year_start, year_end'],
  ['GET /elevation-range', 'Find the valid elevation envelope for the selected scope', 'dataset, year_start, year_end'],
  ['GET /data', 'Return map-ready points for one date', 'date, elevation range, variable, dataset, year range, subregion'],
  ['GET /basin-mean', 'Compute a basin-wide time series', 'start_date, end_date, elevation range, variable, dataset, year range, subregion or ROI polygon'],
  ['GET /stats', 'Return scope-level diagnostics', 'dataset, year range'],
  ['GET /subregions', 'List basin subregions and glacier entries', 'include_glaciers'],
  ['GET /subregions/{id}/geometry', 'Fetch geometry for a selected subregion', 'subregion id'],
  ['GET /glaciers/search', 'Search glacier names and identifiers', 'q, limit'],
  ['GET /glaciers/overview', 'Return glacier polygons for the current map view', 'bbox, zoom'],
  ['GET /hotspot-trends', 'Compute long-term change hotspots from the active year range', 'variable, elevation range, dataset, year range, subregion, min_years'],
  ['POST /nc/upload', 'Upload NetCDF and convert it into an app-compatible dataset', 'file, optional dataset_name'],
  ['GET /outcomes', 'List precomputed outcome modules', 'none'],
  ['GET /outcomes/long-term-hotspot/meta', 'Describe the long-term hotspot output bundle', 'none'],
  ['GET /outcomes/long-term-hotspot/data', 'Load one saved band-mean layer', 'variable, band_id'],
  ['GET /outcomes/long-term-hotspot/difference', 'Load one later-minus-earlier saved change layer', 'variable, comparison_id'],
  ['GET /operations/capabilities', 'Describe the custom-operations helper surface and limits', 'none'],
  ['POST /operations/validate', 'Validate user Python before execution', 'code'],
  ['POST /operations/plan', 'Estimate whether a selection can run inline or should become a job', 'selection payload'],
  ['POST /operations/run', 'Run validated Python inline against the active selection', 'code, selection, timeout_seconds'],
  ['POST /operations/jobs', 'Queue a large analysis job', 'code, selection, timeout_seconds'],
  ['GET /operations/jobs/{job_id}', 'Poll job status and outputs', 'job id'],
  ['GET /operations/jobs/{job_id}/logs', 'Read job logs', 'job id'],
  ['POST /operations/jobs/{job_id}/cancel', 'Cancel a running job', 'job id'],
  ['GET /research/framework/capabilities', 'Describe reusable guided methods and figure types', 'none'],
  ['POST /research/framework/analyze', 'Run a generalized multi-variable research workflow', 'variables, aggregations, period, baseline, elevation, subregion, bounds, methods'],
  ['POST /research/framework/figures', 'Render publication figures from a derived run', 'run_id, figure_type, dpi'],
  ['GET /research/framework/runs/{run_id}/{artifact}', 'Download derived tables, metadata, or figures', 'run id, declared artifact path'],
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
    note: 'Cloud geospatial processing and export platform used during preprocessing.',
  },
  {
    label: 'Copernicus ERA5-Land',
    url: 'https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land',
    note: 'Historical land reanalysis source used by the dashboard and outcome workflows.',
  },
  {
    label: 'NASA NEX-GDDP-CMIP6',
    url: 'https://www.nccs.nasa.gov/services/data-collections/land-based-products/nex-gddp',
    note: 'Reference entry point for the projection-oriented climate dataset family.',
  },
  {
    label: 'NSIDC MOD10A1',
    url: 'https://nsidc.org/data/mod10a1/versions/61',
    note: 'Monthly snow cover and albedo product used in GeoTIFF-backed mode.',
  },
  {
    label: 'CHIRPS precipitation data',
    url: 'https://www.chc.ucsb.edu/data/chirps',
    note: 'Long-term precipitation reference used for rainfall analysis.',
  },
  {
    label: 'NASA SRTM',
    url: 'https://www.earthdata.nasa.gov/data/instruments/srtm',
    note: 'Global elevation reference for terrain context.',
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
      detail: "The project aligns with SAC's remote sensing, geospatial analysis, and environmental monitoring mission.",
    },
    {
      label: 'Workflow modes',
      value: 'Dashboard + Outcomes + Docs + Code',
      detail: 'The app now combines live analysis, saved scientific products, in-app methodology notes, and programmable Python workflows.',
    },
    {
      label: 'Dataset coverage',
      value: '6 built-ins + NetCDF uploads',
      detail: 'ERA5, CMIP6, SPHY, CHIRPS, MOD10A1, discharge, and user-uploaded NetCDF datasets converted into local runtime format.',
    },
    {
      label: 'Advanced tools',
      value: 'Hotspots + glaciers + custom Python',
      detail: 'Includes glacier overlays, trend hotspot analysis, precomputed outcomes, and an optional local assistant for code help.',
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
              This page explains how the Himalayan Basin Analytics WebApp turns climate,
              cryosphere, hydrology, terrain, glacier, and model datasets into an interactive
              research workflow for basin-scale analysis and internship reporting.
            </p>
            <p>
              The documentation has been updated to match the current application surface:
              live dashboard analysis, outcome modules, uploaded NetCDF support, glacier-aware
              search tools, custom Python analysis, and the optional local LLM helper.
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
            works across communication, meteorology, environmental monitoring, navigation,
            disaster support, natural resources, and geospatial applications. A Himalayan basin
            analytics platform fits that mission because it organizes spatial climate and
            cryosphere information into a usable decision and research interface.
          </p>
          <p>
            The project is valuable not just as a software exercise. It reduces repeated manual
            data wrangling, makes Earth observation and reanalysis products easier to compare,
            and creates a common interface for basin boundaries, glaciers, elevation filters,
            time series, and hotspot summaries.
          </p>
          <div className="docs-callout">
            <div className="docs-callout-title">Why this matters at SAC</div>
            <p>
              The app bridges remote-sensing data preparation and interactive interpretation.
              That is especially useful in mountain environments where data products are large,
              mixed in format, and often difficult to compare quickly without a dedicated tool.
            </p>
          </div>
          <ul>
            <li>SAC relevance comes from the combination of earth observation, geospatial filtering, and environmental interpretation.</li>
            <li>The platform supports hydrology, snow, glacier, climate, and terrain-driven basin studies in one interface.</li>
            <li>The documentation view is intended to help convert implementation work into scientific reporting language.</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-overview">
          <h2>2. Workflow Modes and System Overview</h2>
          <p>
            The current application is no longer a map-only dashboard. It is a multi-workflow
            local-first platform built from a FastAPI backend, a React plus Deck.GL plus
            MapLibre frontend, local scientific datasets, and optional extension services.
          </p>
          <table className="docs-table">
            <thead>
              <tr>
                <th>Workflow</th>
                <th>Purpose</th>
                <th>How it is used</th>
              </tr>
            </thead>
            <tbody>
              {workflowRows.map((row) => (
                <tr key={row.module}>
                  <td>{row.module}</td>
                  <td>{row.purpose}</td>
                  <td>{row.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="docs-callout">
            <div className="docs-callout-title">Core design idea</div>
            <p>
              Heavy filtering and aggregation stay in the backend, while the frontend focuses on
              interaction, map rendering, comparison, and reporting. Larger or repeatable
              scientific products can also be saved as outcome bundles instead of being computed
              from scratch during every dashboard session.
            </p>
          </div>
          <ol>
            <li>User chooses either the interactive dashboard or a precomputed outcome module from the start screen.</li>
            <li>For live analysis, the app narrows the dataset by year window before indexing dates and variables.</li>
            <li>The dashboard exposes map, region, glacier, elevation, and time-series controls for the selected scope.</li>
            <li>The code workspace can run validated Python against the active selection or queue a larger job when the selection is too large for inline execution.</li>
          </ol>
          <ul>
            <li>Frontend responsibilities: workflow selection, map rendering, time navigation, graphing, and in-app documentation.</li>
            <li>Backend responsibilities: indexing, schema validation, subsetting, aggregation, hotspot computation, uploads, and operation-job orchestration.</li>
            <li>Deployment style: local-first by design, with optional hosted backend use through frontend environment configuration.</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-datasets">
          <h2>3. Supported Datasets and Runtime Assets</h2>
          <p>
            The live app now serves several dataset families rather than only ERA5 and CMIP6.
            Each dataset uses the same high-level filtering interface, but the storage type may
            differ across Parquet, GeoTIFF, GeoParquet, and uploaded NetCDF conversions.
          </p>
          <table className="docs-table">
            <thead>
              <tr>
                <th>Dataset</th>
                <th>Runtime storage</th>
                <th>Main purpose</th>
                <th>Implementation notes</th>
              </tr>
            </thead>
            <tbody>
              {datasetRows.map((row) => (
                <tr key={row.dataset}>
                  <td>{row.dataset}</td>
                  <td>{row.storage}</td>
                  <td>{row.purpose}</td>
                  <td>{row.notes}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h3>3.1 Runtime spatial assets</h3>
          <ul>
            <li><code>Map_handle/india_admin.pmtiles</code> provides vector-style administrative and context layers.</li>
            <li><code>Map_handle/upper_indus_basin.geojson</code> provides the basin mask and subregion reference structure.</li>
            <li>Local glacier folders under <code>Glacier_shp/</code> provide named glacier selections and overview polygons.</li>
            <li>Outcome bundles under <code>Outcomes/Long_term_hotspot/Outputs</code> provide saved raster-like point layers for quick comparison.</li>
          </ul>
          <h3>3.2 Upload pathway</h3>
          <p>
            Users can now upload NetCDF files directly from the home screen. The backend accepts
            common NetCDF extensions, attempts to detect time and latitude/longitude metadata,
            converts numeric spatial variables into parquet, and registers the result as a new
            local dataset without overwriting the packaged collections.
          </p>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-sources">
          <h2>4. Data Sources and Provenance</h2>
          <p>
            The application uses a layered data stack. Some inputs come from public science
            portals such as NASA Earthdata, Copernicus, NSIDC, and CHIRPS; some are prepared in
            Google Earth Engine; and some are runtime project assets such as glacier polygons,
            basin boundaries, PMTiles, and saved outcomes.
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

          <h3>4.1 Practical provenance chain</h3>
          <p>
            In this project, Earthdata is mainly the discovery and metadata layer, while Earth
            Engine is the preparation layer for aligned exports. The app itself is then the local
            runtime layer that serves those prepared outputs interactively. That distinction is
            important because preprocessing decisions made before runtime directly affect the
            interpretation of the final map and graph outputs.
          </p>
          <h3>4.2 Data classes represented in the app</h3>
          <ul>
            <li>Historical reanalysis fields such as temperature, precipitation, snow depth, SWE, and radiation.</li>
            <li>Future climate projection variables for scenario-oriented comparison.</li>
            <li>Snow and albedo products delivered through GeoTIFF-backed monthly views.</li>
            <li>Precipitation-specific datasets for rainfall analysis.</li>
            <li>Hydrological model or discharge-network style outputs.</li>
            <li>Local basin and glacier vectors used for spatial selection and map interpretation.</li>
            <li>User-uploaded NetCDF datasets converted into reusable local runtime assets.</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-preprocessing">
          <h2>5. Data Preparation and Storage</h2>
          <p>
            The preprocessing pipeline is designed to reduce runtime friction. Large raw exports
            are converted into formats that the backend can query quickly, while map and outcome
            assets are stored in forms that can be loaded incrementally instead of as one large
            in-memory bundle.
          </p>
          <h3>5.1 Main preparation strategy</h3>
          <ol>
            <li>Raw climate or model outputs are exported with time, lon/lat, elevation, and variable fields whenever possible.</li>
            <li>Tabular scientific data are converted to parquet using chunked reading and compression.</li>
            <li>Runtime columns are normalized so the backend can identify date, latitude, longitude, and elevation candidates reliably.</li>
            <li>System or geometry helper columns that should not drive analytics are excluded from the scientific variable list.</li>
            <li>NetCDF uploads are converted into the same runtime-friendly structure used by the dashboard.</li>
          </ol>

          <h3>5.2 Storage classes used in the current app</h3>
          <table className="docs-table">
            <thead>
              <tr>
                <th>Storage type</th>
                <th>Used for</th>
                <th>Runtime behavior</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Parquet</td>
                <td>ERA5, CMIP6, SPHY, CHIRPS, uploaded NetCDF</td>
                <td>Best suited for column projection, year filtering, date indexing, and fast aggregation.</td>
              </tr>
              <tr>
                <td>GeoTIFF</td>
                <td>MOD10A1 monthly snow and albedo</td>
                <td>Read through a GeoTIFF-backed adapter and exposed through the same map and graph surface.</td>
              </tr>
              <tr>
                <td>GeoParquet</td>
                <td>Discharge network and some vector-like sources</td>
                <td>Supports geometry-aware loading while preserving a tabular filtering interface.</td>
              </tr>
              <tr>
                <td>PMTiles / GeoJSON / shapefile assets</td>
                <td>Maps, basin boundaries, glaciers, region geometry</td>
                <td>Used for context layers, selection overlays, geometry fetches, and glacier overview rendering.</td>
              </tr>
            </tbody>
          </table>

          <h3>5.3 Representative unit conversions</h3>
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
            Cross-dataset comparison should still be done carefully because datasets can differ
            in native grid, temporal aggregation, variable definition, and preprocessing history.
          </p>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-runtime">
          <h2>6. Runtime Loading and Performance</h2>
          <p>
            The runtime strategy is based on loading only the subset needed for the active
            dashboard state. That includes dataset, year window, date, variable, elevation
            filter, and optional subregion or glacier selection.
          </p>
          <ul>
            <li>The app asks for the year window first so indexing stays narrower and faster.</li>
            <li>Backend dataset state keeps cached indexes by scope rather than rescanning every file on every interaction.</li>
            <li>Parquet reads use column projection and predicate-style filtering to reduce IO and memory load.</li>
            <li>Frontend requests are cached with a small LRU-style policy so recent frames can be revisited without refetching everything.</li>
            <li>Stale requests are canceled during fast slider movement and mode changes.</li>
            <li>Map responses are capped for browser smoothness, especially for dense datasets and GeoTIFF-backed layers.</li>
            <li>The frontend can talk to either a local backend or a hosted backend through <code>VITE_API_URL</code>.</li>
          </ul>
          <div className="docs-callout">
            <div className="docs-callout-title">Performance principle</div>
            <p>
              The browser is never intended to hold the full scientific archive at once. The app
              stays responsive because the backend serves only the active slice of the dataset and
              the frontend keeps only a small rolling cache of recent results.
            </p>
          </div>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-map">
          <h2>7. Spatial Visualization and Search Tools</h2>
          <h3>7.1 Layer stack</h3>
          <ol>
            <li>Base map theme and UI theme selection.</li>
            <li>PMTiles-based India context boundaries and labels where glyphs are available.</li>
            <li>Basin overlay for the main watershed context.</li>
            <li>Selected subregion or glacier boundary overlay.</li>
            <li>Scientific points rendered with Deck.GL scatter symbols.</li>
            <li>Optional ROI polygon, selected subregion, glacier boundary, or custom operation result layer.</li>
          </ol>

          <h3>7.2 Search and region tools</h3>
          <ul>
            <li>Search supports basin subregions and named glacier entries from the same search surface.</li>
            <li>Coordinate tools support direct latitude and longitude lookup.</li>
            <li>The ROI polygon supports local region-of-interest graphing and variable loading.</li>
            <li>Glacier overview mode loads viewport-limited glacier polygons and intentionally waits for a suitable zoom level.</li>
            <li>Subregion geometry can be fetched directly when a basin or glacier item is selected.</li>
          </ul>

          <h3>7.3 Color classification</h3>
          <p>
            For the current filtered layer, the app computes the minimum and maximum values and
            then divides the range into equal-interval bins. The legend is therefore dynamic and
            relative to the current filtered view.
          </p>
          <pre className="docs-code">{`p20 = min + 0.2 * (max - min)
p40 = min + 0.4 * (max - min)
p60 = min + 0.6 * (max - min)
p80 = min + 0.8 * (max - min)`}</pre>
          <p>
            In daily mode the legend expresses low-to-high values. In hotspot or difference
            views, the same map machinery is reused, but the scientific meaning becomes trend
            slope or later-minus-earlier change rather than a single daily measurement.
          </p>

          <h3>7.4 Snapshot and print layout</h3>
          <p>
            The Snapshot button in the map canvas opens a publication-layout workflow without
            adding work to normal map rendering. The tool is downloaded only when it is opened.
            Drag a print crop area to isolate the required map view; the rest of
            the application is dimmed while the selected area remains clear.
          </p>
          <ul>
            <li>Configure A4, A3, Letter, or square pages in portrait or landscape orientation.</li>
            <li>Add a map title, subtitle, legend, scale bar, north arrow, coordinates, timestamp, and frame.</li>
            <li>Publication exports render regular climate observations as native grid-cell footprints rather than circular dots, with opaque values and reference boundaries redrawn above the data.</li>
            <li>Choose fit or fill behavior, page margins, background color, and 96, 150, or 300 DPI output.</li>
            <li>Export PNG, JPEG, or SVG, or use the system print dialog for printing and Save as PDF.</li>
            <li>The print-layout module is isolated from data requests and analytical state, so opening or closing it does not refetch scientific data.</li>
            <li>Dynamic labels accept fields such as <code>[% region %]</code>, <code>[% variable %]</code>, <code>[% date %]</code>, and user-defined layout variables.</li>
            <li>Reusable named templates are stored locally and can restore the complete layout configuration.</li>
            <li>An optional projected coordinate grid supports automatic or explicit degree intervals and solid or dashed styles.</li>
            <li>Atlas mode batch-renders up to ten basin subregions, highlights each current feature, and sends the resulting multi-page document to Print / Save as PDF.</li>
            <li>Report mode can append a structured metadata page containing region, variable, date, value range, extent, scale, author, organization, and output specification.</li>
          </ul>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-analytics">
          <h2>8. Time Series, Region, and Trend Analysis</h2>
          <h3>8.1 Basin mean graph</h3>
          <p>
            Basin mode groups the selected points by date and computes a daily mean for the
            active variable. This gives a compact temporal summary for the currently selected
            dataset, year range, elevation band, and optional subregion context.
          </p>
          <h3>8.2 Region and glacier-focused analysis</h3>
          <p>
            When the ROI polygon, basin subregion, or glacier region is active, the backend narrows
            the selected points before aggregation. That makes it possible to compare local
            behavior within glacier-fed areas or smaller hydrological units instead of always
            looking only at the full basin.
          </p>
          <h3>8.3 Daily map mode versus hotspot mode</h3>
          <ul>
            <li>Daily mode shows the selected date frame and moves directly with the time slider.</li>
            <li>Hotspot mode uses the full year range to fit a trend at each location.</li>
            <li>The hotspot controls include a minimum yearly coverage threshold so trend fitting ignores weak annual support.</li>
            <li>In hotspot mode the time slider still moves the graph marker, but it does not change the fitted trend map itself.</li>
          </ul>
          <pre className="docs-code">{`Y = aX + b

Y = annual mean value
X = year
a = trend slope
b = intercept`}</pre>
          <div className="docs-callout">
            <div className="docs-callout-title">Interpretation note</div>
            <p>
              A hotspot layer is not a daily anomaly layer. It is a summary of long-range change
              intensity computed over the full selected year window for the active dataset and
              filter set.
            </p>
          </div>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-outcomes">
          <h2>9. Outcome Modules and Precomputed Products</h2>
          <p>
            The outcomes workflow is intended for scientific products that should open quickly
            and compare consistently without recomputing them during normal dashboard use. The
            current implementation includes a dedicated Long Term Hotspot Analysis module.
          </p>
          <h3>9.1 Current outcome module</h3>
          <ul>
            <li>Outcome name: Long Term Hotspot Analysis.</li>
            <li>Source dataset: ERA5.</li>
            <li>Primary outputs: saved 25-year spatial mean bands and saved later-minus-earlier difference layers.</li>
            <li>Metadata endpoint: <code>/outcomes/long-term-hotspot/meta</code>.</li>
            <li>Data endpoints: <code>/outcomes/long-term-hotspot/data</code> and <code>/outcomes/long-term-hotspot/difference</code>.</li>
          </ul>
          <h3>9.2 Why saved outcomes help</h3>
          <p>
            Precomputed outputs are useful when the same spatial summaries are revisited often.
            They reduce repeated read and aggregation cost, keep comparisons stable, and provide a
            cleaner presentation surface for review sessions and reporting.
          </p>
          <h3>9.3 Regeneration path</h3>
          <p>
            Outcome bundles are generated from scripts in
            <code>Outcomes/Long_term_hotspot/Scripts</code>, especially
            <code>compute_era5_band_means.py</code> and
            <code>compute_band_differences.py</code>. After regeneration, the backend reloads the
            saved parquet and JSON metadata so the outcome viewer can expose the new bands or
            comparisons.
          </p>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-research">
          <h2>10. General Research Toolkit</h2>
          <p>
            The Research button is part of the live dashboard, not a separate study module. It
            receives the current dataset, response variable, year range, elevation filter,
            subregion, and ROI polygon. Researchers can add up to three related variables
            from any other loaded dataset and choose the annual reducer for each variable.
          </p>
          <h3>10.1 Reusable methods</h3>
          <ul>
            <li>Area-weighted regional series and baseline-standardized anomalies.</li>
            <li>Pixelwise Theil–Sen slopes with regional HAC and Mann–Kendall inference.</li>
            <li>Persistent time of emergence and Pettitt shift screening with false-discovery-rate control.</li>
            <li>Regional Pearson/Spearman relations, lead–lag sensitivity, spatial cross-sections, and local temporal correlation.</li>
            <li>Joint positive or negative standardized anomaly footprints for the first related variable.</li>
          </ul>
          <h3>10.2 Cross-dataset behavior</h3>
          <p>
            Related data are sampled to the response grid by nearest cell. Every run records the
            source and response pixel counts plus median and maximum coordinate offsets. Static
            environmental covariates such as terrain are treated as spatial drivers even when
            their reference year lies outside the active temporal window.
          </p>
          <h3>10.3 Reproducibility and data protection</h3>
          <p>
            Source datasets are read-only. Each run writes its request, summary, annual series,
            pixel metrics, relationship table, and optional 600-dpi PNG/TIFF/PDF figures to a new
            directory under <code>Outcomes/Research_Framework/runs</code>. Statistical
            association, lag, emergence, and detected shifts are diagnostics and do not by
            themselves establish environmental causation.
          </p>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-advanced">
          <h2>11. Custom Operations Workspace and Optional LLM Assistance</h2>
          <p>
            The dashboard now contains an HB code workspace that allows users to run controlled
            Python analysis directly against the active selection. This is useful for custom plots,
            quick summaries, experimental metrics, and exportable derived tables without leaving
            the application.
          </p>
          <h3>11.1 Code workspace behavior</h3>
          <ul>
            <li>The editor uses Monaco and opens in a side panel within the dashboard.</li>
            <li>User code is validated first through the backend security layer before execution.</li>
            <li>Small selections run inline through <code>/operations/run</code>.</li>
            <li>
              Large Parquet selections are planned first and then queued through
              <code>/operations/jobs</code>. The isolated worker scans the original files in place;
              it does not copy or deserialize the selected source rows into a job dataframe.
            </li>
            <li>Outputs can include terminal text, numeric tiles, tables, charts, exports, and map layers rendered back into the dashboard.</li>
          </ul>
          <h3>11.2 Supported helper patterns</h3>
          <p>
            Current helper functions support outputs such as <code>hb.table</code>,
            <code>hb.number</code>, <code>hb.chart</code>, <code>hb.chart_line</code>,
            <code>hb.chart_scatter</code>, <code>hb.chart_histogram</code>,
            <code>hb.map_points</code>, <code>hb.export_csv</code>, and
            <code>hb.export_json</code>. For large jobs, use <code>hb.sql</code> for lazy,
            data-local queries and <code>hb.export_query</code> to stream CSV or Parquet artifacts
            directly from the analytical engine. <code>hb.aggregate</code> and
            <code>hb.iter_data</code> are available for structured aggregation and bounded-batch
            custom logic. Interactive results are capped at 250,000 rows; exports are not forced
            through the browser boundary.
          </p>
          <h3>11.3 Security model</h3>
          <p>
            The operation runner is intentionally restricted. It uses AST validation, restricted
            imports, subprocess isolation, timeouts, output caps, and controlled exports. That
            makes it suitable for local-first or supervised use even though it is not intended as
            an unrestricted general Python shell.
          </p>
          <h3>11.4 Optional LLM helper</h3>
          <p>
            The chatbot tab is optional and separate from the main backend. It talks to the local
            LLM service on port <code>8010</code>, can answer questions about the current
            dashboard context, and can draft code that users may insert directly into the editor.
            If the service is not running, the rest of the dashboard still works normally.
          </p>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-api">
          <h2>12. API Surface and Filtering Logic</h2>
          <p>
            The API has expanded beyond dataset discovery and live map requests. It now includes
            outcome retrieval, NetCDF upload support, glacier search, and a dedicated custom
            operations surface for programmable analysis.
          </p>
          <table className="docs-table">
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Purpose</th>
                <th>Main filters or inputs</th>
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
            The usual filtering order is dataset, year range, and variable scope first; then date
            or date range; then elevation; and finally optional subregion or geometry narrowing.
            This ordering keeps payloads smaller and reduces unnecessary processing.
          </p>
          <p>
            GeoTIFF-backed and GeoParquet-backed datasets share the same high-level API surface,
            but their internal loading path differs from ordinary parquet-backed datasets. That is
            one reason the documentation should state not just the endpoint used, but also the
            dataset family involved.
          </p>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-science-use">
          <h2>13. Scientific Interpretation Guide</h2>
          <ul>
            <li>Use basin mode for domain-scale behavior under a clearly stated elevation range and year window.</li>
            <li>Use region, sub-basin, or glacier selection when the scientific question is local rather than basin-wide.</li>
            <li>State whether the result comes from live daily analysis, hotspot fitting, or a saved outcome module.</li>
            <li>Report the exact dataset family, because ERA5, CMIP6, MOD10A1, CHIRPS, SPHY, discharge, and uploaded NetCDF datasets are not interchangeable.</li>
            <li>Document the spatial filter, year range, active variable, and elevation bounds for every exported figure or chart.</li>
            <li>For hotspot interpretation, remember that the map shows trend slope or change intensity, not a single daily state.</li>
          </ul>
          <div className="docs-callout">
            <div className="docs-callout-title">Good reporting habit</div>
            <p>
              A strong report caption should mention the workflow mode, dataset family, variable,
              date or year window, elevation filter, and whether the layer is a raw daily value,
              an aggregated mean, a hotspot slope, or a precomputed difference map.
            </p>
          </div>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-limitations">
          <h2>14. Assumptions, Limitations, and Reproducibility</h2>
          <h3>14.1 Main limitations</h3>
          <ul>
            <li>Daily means are arithmetic means across selected points; area-weighted averaging is not currently applied.</li>
            <li>Color bins are dynamic for the current filtered view, so legends are not fixed across all dates or all datasets.</li>
            <li>Cross-dataset comparisons can be misleading if differences in grid size, preprocessing, or temporal aggregation are ignored.</li>
            <li>GeoTIFF-backed and GeoParquet-backed datasets may use fallback elevation behavior that differs from parquet datasets with explicit per-point elevation.</li>
            <li>Large map responses are intentionally capped for browser performance, so display density may be lower than the raw stored point count.</li>
            <li>Custom operations are sandboxed and intentionally limited; they are not a replacement for unrestricted scientific computing environments.</li>
          </ul>
          <h3>14.2 Reproducibility checklist</h3>
          <ol>
            <li>Record the workflow mode used: dashboard, hotspot mode, outcome module, or custom operation.</li>
            <li>Record dataset name, variable, year range, elevation range, and region or glacier selection.</li>
            <li>Keep the exact source file set or generated upload dataset used for the session.</li>
            <li>For outcomes, record the band or comparison identifier used in the viewer.</li>
            <li>For custom operations, keep the executed Python code and any exported result files.</li>
            <li>When using the chatbot, treat generated code as draft assistance and preserve the final edited code version that was actually run.</li>
          </ol>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>

        <section id="doc-references">
          <h2>15. Reference Sources</h2>
          <p>
            The following official references are the most relevant public sources for the data
            families and platform context represented in this app.
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
            For implementation detail, the most relevant internal references are
            <code> backend/main.py </code> for the API and dataset registry,
            <code> frontend/src/services/api.js </code> for the client calls,
            <code> frontend/src/App.jsx </code> for workflow orchestration,
            <code> frontend/src/components/OutcomeLongTermHotspotPage.jsx </code> for the
            outcome viewer, and <code>backend/custom_operations/README.md</code> plus
            <code>LLM_service/README.md</code> for the advanced analysis surfaces.
          </p>
          <a className="docs-top-link" href="#doc-top">Back to top</a>
        </section>
      </article>
    </div>
  );
}

export default React.memo(DocumentationPage);
