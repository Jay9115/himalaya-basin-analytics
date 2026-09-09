# Himalayan Basin Analytics - Vercel Frontend Deployment..

This is the dedicated deployment branch (`Frontend-deployed`) of the [himalaya-basin-analytics](https://github.com/Jay9115/himalaya-basin-analytics) repository, optimized specifically for zero-configuration continuous deployment on **Vercel**.

## Architecture & Integration

- **Frontend Hosting**: Vercel (React 18 + Vite + Deck.GL + MapLibre GL)
- **Backend API**: Hugging Face Spaces (`https://jay9115-himalaya-web-backend.hf.space`)
- **Data Repository**: Hugging Face Datasets (`Jay9115/Himalaya-data`)

The frontend communicates directly with the Hugging Face Spaces backend API for all dynamic analytics, parquet queries, PMTiles map vectors, GeoJSON boundaries, and data downloads.

## Environment Variables

| Variable | Description | Default / Production Value |
| :--- | :--- | :--- |
| `VITE_API_URL` | Base URL of the FastAPI backend | `https://jay9115-himalaya-web-backend.hf.space` |
| `VITE_LLM_URL` | Optional URL for local/hosted LLM assistant | `http://127.0.0.1:8010` |
| `VITE_INDIA_PM_TILES_URL` | Optional custom PMTiles vector tile source | `${VITE_API_URL}/map-assets/india_admin.pmtiles` |
| `VITE_BASIN_GEOJSON_URL` | Optional custom basin GeoJSON boundary | `${VITE_API_URL}/map-assets/upper_indus_basin.geojson` |
| `VITE_GLYPHS_URL` | Optional custom PBF font glyphs | `${VITE_API_URL}/map-assets/fonts/{fontstack}/{range}.pbf` |

## Deploying to Vercel

1. Log into your [Vercel Dashboard](https://vercel.com).
2. Click **Add New** > **Project**.
3. Import your GitHub repository: `Jay9115/himalaya-basin-analytics`.
4. In the configuration modal:
   - **Branch**: Select `Frontend-deployed`.
   - **Framework Preset**: Vite (detected automatically).
   - **Root Directory**: `./` (leave default).
   - **Build Command**: `npm run build` (or leave default).
   - **Output Directory**: `dist` (or leave default).
5. In **Environment Variables**, add:
   - `VITE_API_URL`: `https://jay9115-himalaya-web-backend.hf.space`
6. Click **Deploy**.

## Local Development

```bash
# Install dependencies
npm install

# Run Vite dev server (points to localhost:8000 by default)
npm run dev

# Build production bundle
npm run build

# Preview production build locally
npm run preview
```
