FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Install backend dependencies first for Docker layer caching.
COPY backend/requirements.txt /app/backend/requirements.txt
RUN pip install --upgrade pip setuptools wheel && \
    pip install -r /app/backend/requirements.txt

# Copy runtime application files.
COPY backend /app/backend
COPY Database /app/Database
COPY Map_handle /app/Map_handle

EXPOSE 7860
ENV PORT=7860

# Hugging Face Spaces sets PORT automatically for Docker Spaces.
CMD ["sh", "-c", "uvicorn main:app --app-dir /app/backend --host 0.0.0.0 --port ${PORT:-7860} --workers 1"]
