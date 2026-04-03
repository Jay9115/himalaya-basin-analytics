# Himalaya Basin Analytics WebApp

Local-first web application for climate and hydro-meteorological analysis over the Himalayan region.

This project includes:
- FastAPI backend for parquet querying and aggregation
- React + Deck.GL + MapLibre frontend for map and time-series visualization
- ERA5 and CMIP6 parquet datasets
- PMTiles + GeoJSON map assets
- Offline packaging script for one-click distribution

## Current Repository Layout

```text
himalaya-basin-analytics/
  backend/
    main.py
    requirements.txt
  frontend/
    src/
    dist/                    # built frontend (generated)
  Database/
    Full_Shape_ERA5/
    Full_shape_CMIP6/
  Map_handle/
    india_admin.pmtiles
    upper_indus_basin.geojson
    fonts/
  Himalaya_shape/
    him_watershed.shp (+ sidecar files)
  pack_offline.ps1
  start.bat
  stop.bat
```

## Data and Map Sources Used at Runtime

Backend runtime paths are resolved relative to app root:
- Dataset folders:
  - `Database/Full_Shape_ERA5`
  - `Database/Full_shape_CMIP6`
- Map assets folder:
  - `Map_handle/`

Basin boundary overlay currently loads from:
- `Map_handle/upper_indus_basin.geojson`

India boundary layer currently loads from:
- `Map_handle/india_admin.pmtiles`

## Prerequisites (Developer Mode)

- Python 3.10+ (3.12 tested)
- Node.js 18+ (16+ works)
- Windows PowerShell (for scripts)

## Run Locally (Developer Workflow)

### 1) Backend

```powershell
cd D:\ISRO-SWOT\Webapp\himalaya-basin-analytics\backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python main.py
```

Backend URL:
- `http://127.0.0.1:8000`

Health check:
- `http://127.0.0.1:8000/health`

### 2) Frontend (new terminal)

```powershell
cd D:\ISRO-SWOT\Webapp\himalaya-basin-analytics\frontend
npm install
npm run dev
```

Frontend URL:
- `http://localhost:5173`

### Optional one-click dev launcher

From repo root:

```powershell
.\start.bat
```

## Core API Endpoints

- `GET /datasets`
- `GET /years?dataset=era5|cmip6`
- `GET /dates?dataset=...&year_start=...&year_end=...`
- `GET /variables?dataset=...&year_start=...&year_end=...`
- `GET /elevation-range?dataset=...&year_start=...&year_end=...`
- `GET /data?date=...&elev_min=...&elev_max=...&variable=...&dataset=...`
- `GET /basin-mean?start_date=...&end_date=...&elev_min=...&elev_max=...&variable=...&dataset=...`
- `GET /region-mean?year=...&min_lat=...&max_lat=...&min_lon=...&max_lon=...&elev_min=...&elev_max=...&variable=...&dataset=...`
- `GET /stats?dataset=...&year_start=...&year_end=...`
- `GET /map-assets/{asset_path}`

## Offline Packaging (Distribution Build)

Use this single script to sync a portable offline bundle:

```powershell
powershell -ExecutionPolicy Bypass -File "D:\ISRO-SWOT\Webapp\himalaya-basin-analytics\pack_offline.ps1"
```

What it does:
- Builds frontend (`npm run build`) unless skipped
- Builds backend executable (`webapp_backend.exe`) with PyInstaller in an isolated build venv
- Syncs portable runtime to:
  - `D:\ISRO-SWOT\Webapp_packed\webapp_backend`
- Mirrors:
  - `frontend\dist` -> `webapp_backend\frontend_dist`
  - `Database` -> `webapp_backend\Database`
  - `Map_handle` -> `webapp_backend\Map_handle`
- Regenerates:
  - `D:\ISRO-SWOT\Webapp_packed\START_APP.bat`
  - `D:\ISRO-SWOT\Webapp_packed\STOP_APP.bat`
  - `D:\ISRO-SWOT\Webapp_packed\README_OFFLINE.txt`
- Removes temporary build artifacts by default (`D:\ISRO-SWOT\Webapp_packed\_build`)

Skip frontend build:

```powershell
powershell -ExecutionPolicy Bypass -File "D:\ISRO-SWOT\Webapp\himalaya-basin-analytics\pack_offline.ps1" -SkipFrontendBuild
```

Skip backend rebuild (reuse an already-built runtime):

```powershell
powershell -ExecutionPolicy Bypass -File "D:\ISRO-SWOT\Webapp\himalaya-basin-analytics\pack_offline.ps1" -SkipBackendBuild -BuiltRuntime "D:\YOUR_PATH\dist\webapp_backend"
```

Keep `_build` artifacts for debugging/repeat builds:

```powershell
powershell -ExecutionPolicy Bypass -File "D:\ISRO-SWOT\Webapp\himalaya-basin-analytics\pack_offline.ps1" -KeepBuildArtifacts
```

## Notes

- Runtime analysis uses parquet files; CSV files are not required at runtime.
- Map asset updates should be made inside `Map_handle/` and then packed again.
- For scientific method details, use the in-app Documentation tab.
