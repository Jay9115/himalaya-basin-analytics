# Hugging Face Backend Deployment (No Local Docker Needed)

This project now includes Docker deployment files:
- `Dockerfile`
- `.dockerignore`

You do **not** need Docker installed on your PC. Hugging Face builds the container in the cloud after push.

## 1) Create a new Hugging Face Space

1. Go to Hugging Face -> `New Space`
2. Choose:
   - SDK: `Docker`
   - Visibility: as needed
   - Hardware: `CPU Basic` (or higher if needed)

## 2) Upload/push backend project

Push this folder content to the Space repository:
- `backend/`
- `Database/`
- `Map_handle/`
- `Dockerfile`
- `.dockerignore`

## 3) Add Space metadata in README.md

Hugging Face Spaces expects YAML front matter in `README.md` at repo root. Use this at the top:

```md
---
title: Himalaya Basin Backend
emoji: 🛰️
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---
```

## 4) Build and run

After push, Spaces will:
1. Build the Docker image from `Dockerfile`
2. Start the backend on port `7860`

## 5) Verify

Open:
- `/health`
- `/datasets`

Example:
- `https://<your-space-name>.hf.space/health`

## Notes

- Backend expects parquet and map assets inside:
  - `/app/Database`
  - `/app/Map_handle`
- Frontend can stay on Vercel and call this backend URL.
- If CORS blocks Vercel frontend, update `allow_origins` in `backend/main.py` to include your Vercel domain.
