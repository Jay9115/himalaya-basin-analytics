Himalaya Basin Analytics - Offline Portable Bundle
===================================================

This packed directory contains the complete standalone Himalaya Basin Analytics WebApp
including the compiled FastAPI backend, worker engines, full frontend bundle, offline
map/PMTiles assets, and workspace directories.

HOW TO RUN:
  1) Double-click START_APP.bat
  2) The backend will start automatically and launch http://127.0.0.1:8000 in your browser.
  3) To stop the application, double-click STOP_APP.bat.

FEATURES INCLUDED:
  - Basin-wide temperature, precipitation & discharge visualization
  - MapView with India Admin & Upper Indus PMTiles basemaps
  - Export Data module (Temporal CSV, Spatial GeoTIFF/CSV, dataset switcher, variable selector)
  - Custom Operations (Monaco Editor Python code execution via sandbox & large workers)
  - Research Studio & Project Workspace management
  - Shapefile upload & ROI clipping

DATABASE / DATASET PAYLOADS:
  This portable bundle is packed without the multi-gigabyte dataset files.
  To enable full data queries for specific datasets, copy their parquet/geotiff files into:
    webapp_backend\Database\
      - Full_Shape_ERA5\        (ERA5 Parquet files)
      - Full_shape_CMIP6\       (CMIP6 Parquet files)
      - SPHY_Model\             (SPHY Model Parquet files)
      - CHIRPS\                 (CHIRPS Precipitation Parquet files)
      - MOD10A1_Parquet\        (MOD10A1 Parquet files)
      - Discharge_Geopar\       (River network GeoParquet files)
      - Uploaded_NC\            (NetCDF custom uploaded datasets)

NO INSTALLATION REQUIRED:
  - No Python or Node.js installation is required on the target machine.
  - All runtimes, DLLs, and dependencies are bundled within webapp_backend\.
