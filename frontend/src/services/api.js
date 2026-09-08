import axios from 'axios';

const isLocalBrowser = typeof window !== 'undefined'
  && ['localhost', '127.0.0.1'].includes(window.location.hostname);
// Local development and the offline desktop build must use the matching local
// FastAPI process. The hosted API remains the fallback for remote deployments.
const DEFAULT_API_BASE_URL = (import.meta.env.DEV || isLocalBrowser)
  ? 'http://127.0.0.1:8000'
  : 'https://jay9115-himalaya-web-backend.hf.space';
const API_BASE_URL = import.meta.env.VITE_API_URL || DEFAULT_API_BASE_URL;

class APIService {
  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: 60000,
    });

    this.cache = new Map();
    this.inFlight = new Map();
    this.maxCacheSize = 48;
    // Large map frames dominate browser memory. Keep a small rolling buffer
    // instead of retaining dozens of 30k-75k point responses.
    this.maxCacheWeight = 200000;
    this.cacheWeight = 0;
    this.cacheGeneration = 0;
    this.defaultCacheTtlMs = 5 * 60 * 1000;
  }

  getCacheKey(endpoint, params) {
    return `${endpoint}?${JSON.stringify(params)}`;
  }

  getCacheWeight(payload) {
    const dataPoints = Array.isArray(payload?.data) ? payload.data.length : 0;
    return Math.max(1, dataPoints);
  }

  deleteCacheEntry(cacheKey) {
    const existing = this.cache.get(cacheKey);
    if (!existing) return;
    this.cacheWeight -= existing.weight;
    this.cache.delete(cacheKey);
  }

  readCache(cacheKey) {
    const existing = this.cache.get(cacheKey);
    if (!existing) return undefined;
    if (existing.expiresAt <= Date.now()) {
      this.deleteCacheEntry(cacheKey);
      return undefined;
    }
    // Refresh insertion order so eviction behaves as a true LRU cache.
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, existing);
    return existing.payload;
  }

  writeCache(cacheKey, payload, ttlMs) {
    const weight = this.getCacheWeight(payload);
    if (weight > this.maxCacheWeight) return;

    this.deleteCacheEntry(cacheKey);
    this.cache.set(cacheKey, {
      payload,
      weight,
      expiresAt: Date.now() + ttlMs,
    });
    this.cacheWeight += weight;

    while (this.cache.size > this.maxCacheSize || this.cacheWeight > this.maxCacheWeight) {
      const oldestKey = this.cache.keys().next().value;
      this.deleteCacheEntry(oldestKey);
    }
  }

  withDataset(params, dataset) {
    if (!dataset) return params;
    return { ...params, dataset };
  }

  withYearRange(params, yearRange) {
    if (!yearRange) return params;
    const nextParams = { ...params };
    if (Number.isInteger(yearRange.start)) {
      nextParams.year_start = yearRange.start;
    }
    if (Number.isInteger(yearRange.end)) {
      nextParams.year_end = yearRange.end;
    }
    return nextParams;
  }

  withContext(params, dataset, yearRange) {
    return this.withYearRange(this.withDataset(params, dataset), yearRange);
  }

  async getWithCache(endpoint, params = {}, config = {}) {
    const {
      cache: shouldUseCache = true,
      cacheTtlMs = this.defaultCacheTtlMs,
      ...requestConfig
    } = config;
    const cacheKey = this.getCacheKey(endpoint, params);

    if (shouldUseCache) {
      const cached = this.readCache(cacheKey);
      if (cached !== undefined) return cached;

      // Prefetches do not carry a signal and can safely be shared with the
      // foreground request for the same frame.
      const pending = this.inFlight.get(cacheKey);
      if (pending) return pending;
    }

    const generation = this.cacheGeneration;
    const request = this.client.get(endpoint, { params, ...requestConfig })
      .then((response) => {
        if (shouldUseCache && generation === this.cacheGeneration) {
          this.writeCache(cacheKey, response.data, cacheTtlMs);
        }
        return response.data;
      });

    if (shouldUseCache && !requestConfig.signal) {
      this.inFlight.set(cacheKey, request);
      try {
        return await request;
      } finally {
        if (this.inFlight.get(cacheKey) === request) {
          this.inFlight.delete(cacheKey);
        }
      }
    }

    return request;
  }

  async getDatasets() {
    return this.getWithCache('/datasets');
  }

  async getOutcomes() {
    return this.getWithCache('/outcomes');
  }

  async getProjects() {
    return this.getWithCache('/projects', {}, { cache: false });
  }

  async createProject(payload) {
    const response = await this.client.post('/projects', payload);
    return response.data;
  }

  async getProject(projectId) {
    const response = await this.client.get(`/projects/${encodeURIComponent(projectId)}`);
    return response.data;
  }

  async saveProject(projectId, workspace, code) {
    const response = await this.client.put(
      `/projects/${encodeURIComponent(projectId)}/workspace`,
      { workspace, code }
    );
    return response.data;
  }

  async updateProject(projectId, changes) {
    const response = await this.client.patch(`/projects/${encodeURIComponent(projectId)}`, changes);
    return response.data;
  }

  async archiveProject(projectId) {
    const response = await this.client.post(`/projects/${encodeURIComponent(projectId)}/archive`);
    return response.data;
  }

  async deleteProject(projectId) {
    const response = await this.client.delete(`/projects/${encodeURIComponent(projectId)}`);
    return response.data;
  }

  async getLongTermHotspotMeta() {
    return this.getWithCache('/outcomes/long-term-hotspot/meta');
  }

  async getLongTermHotspotData(variable, bandId, signal, aoi) {
    const params = { variable, band_id: bandId };
    if (aoi) Object.assign(params, this.withAoi({}, aoi));
    return this.getWithCache(
      '/outcomes/long-term-hotspot/data',
      params,
      { signal }
    );
  }

  async getLongTermHotspotDifference(variable, comparisonId, signal, aoi) {
    const params = { variable, comparison_id: comparisonId };
    if (aoi) Object.assign(params, this.withAoi({}, aoi));
    return this.getWithCache(
      '/outcomes/long-term-hotspot/difference',
      params,
      { signal }
    );
  }

  outcomePath(outcomeId) {
    return String(outcomeId || 'long_term_hotspot').replaceAll('_', '-');
  }

  async getOutcomeMeta(outcomeId) {
    return this.getWithCache(`/outcomes/${this.outcomePath(outcomeId)}/meta`);
  }

  async getOutcomeData(outcomeId, variable, bandId, signal, aoi) {
    const params = { variable, band_id: bandId };
    if (aoi) Object.assign(params, this.withAoi({}, aoi));
    return this.getWithCache(
      `/outcomes/${this.outcomePath(outcomeId)}/data`,
      params,
      { signal }
    );
  }

  async getOutcomeDifference(outcomeId, variable, comparisonId, signal, aoi) {
    const params = { variable, comparison_id: comparisonId };
    if (aoi) Object.assign(params, this.withAoi({}, aoi));
    return this.getWithCache(
      `/outcomes/${this.outcomePath(outcomeId)}/difference`,
      params,
      { signal }
    );
  }

  async uploadNcDataset(file, datasetName) {
    const formData = new FormData();
    formData.append('file', file);
    if (datasetName && datasetName.trim()) {
      formData.append('dataset_name', datasetName.trim());
    }

    const response = await this.client.post('/nc/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 0, // NetCDF conversion may take longer than normal query timeout.
    });
    this.clearCache();
    return response.data;
  }

  async getAvailableYears(dataset) {
    return this.getWithCache('/years', this.withDataset({}, dataset));
  }

  async getAvailableDates(dataset, yearRange) {
    return this.getWithCache('/dates', this.withContext({}, dataset, yearRange));
  }

  async getAvailableVariables(dataset, yearRange) {
    return this.getWithCache('/variables', this.withContext({}, dataset, yearRange));
  }

  async getElevationRange(dataset, yearRange) {
    return this.getWithCache('/elevation-range', this.withContext({}, dataset, yearRange));
  }

  async getSubregions(includeGlaciers = true) {
    return this.getWithCache('/subregions', { include_glaciers: includeGlaciers });
  }

  async searchGlaciers(query, limit = 50, signal) {
    const trimmed = (query || '').trim();
    if (!trimmed) {
      return { results: [], count: 0, query: '' };
    }
    return this.getWithCache('/glaciers/search', { q: trimmed, limit }, { signal });
  }

  async getSubregionGeometry(subregionId, signal) {
    if (!subregionId) {
      return null;
    }
    const encoded = encodeURIComponent(subregionId);
    return this.getWithCache(`/subregions/${encoded}/geometry`, {}, { signal });
  }

  withAoi(params, aoi) {
    if (!aoi?.geometry) return params;
    return {
      ...params,
      aoi_geojson: JSON.stringify({
        type: 'Feature',
        properties: {
          id: aoi.id,
          label: aoi.name || aoi.label || 'ROI',
        },
        geometry: aoi.geometry,
      }),
    };
  }

  async getData(date, elevMin, elevMax, variable, dataset, signal, yearRange, subregionId, aoi) {
    const params = this.withContext(
      {
        date,
        elev_min: elevMin,
        elev_max: elevMax,
        variable,
      },
      dataset,
      yearRange
    );
    if (aoi) {
      Object.assign(params, this.withAoi({}, aoi));
    } else if (subregionId) {
      params.subregion_id = subregionId;
    }
    return this.getWithCache(
      '/data',
      params,
      { signal, cacheTtlMs: 2 * 60 * 1000 }
    );
  }

  async prefetchData(date, elevMin, elevMax, variable, dataset, yearRange, subregionId, aoi) {
    return this.getData(
      date,
      elevMin,
      elevMax,
      variable,
      dataset,
      undefined,
      yearRange,
      subregionId,
      aoi
    );
  }

  async getBasinMean(startDate, endDate, elevMin, elevMax, variable, dataset, signal, yearRange, subregionId, aoi) {
    const params = this.withContext(
      {
        start_date: startDate,
        end_date: endDate,
        elev_min: elevMin,
        elev_max: elevMax,
        variable,
      },
      dataset,
      yearRange
    );
    if (aoi) {
      Object.assign(params, this.withAoi({}, aoi));
    } else if (subregionId) {
      params.subregion_id = subregionId;
    }
    return this.getWithCache(
      '/basin-mean',
      params,
      { signal }
    );
  }

  async getStats(dataset, yearRange) {
    return this.getWithCache('/stats', this.withContext({}, dataset, yearRange));
  }

  async getHotspotTrends(elevMin, elevMax, variable, dataset, signal, yearRange, subregionId, minYears = 3, aoi) {
    const params = this.withContext(
      {
        elev_min: elevMin,
        elev_max: elevMax,
        variable,
        min_years: minYears,
      },
      dataset,
      yearRange
    );
    if (aoi) {
      Object.assign(params, this.withAoi({}, aoi));
    } else if (subregionId) {
      params.subregion_id = subregionId;
    }
    return this.getWithCache(
      '/hotspot-trends',
      params,
      { signal }
    );
  }

  async getOperationCapabilities() {
    return this.getWithCache('/operations/capabilities');
  }

  async getResearchCapabilities() {
    return this.getWithCache('/research/capabilities', {}, { cacheTtlMs: 30 * 60 * 1000 });
  }

  async runResearchAnalysis(payload, signal) {
    const response = await this.client.post('/research/analyze', payload, {
      signal,
      timeout: 0,
    });
    return response.data;
  }

  async createResearchFigure(payload, signal) {
    const response = await this.client.post('/research/figures', payload, {
      signal,
      timeout: 0,
    });
    return response.data;
  }

  async getResearchFrameworkCapabilities() {
    return this.getWithCache('/research/framework/capabilities', {}, { cacheTtlMs: 30 * 60 * 1000 });
  }

  async runResearchFramework(payload, signal) {
    const response = await this.client.post('/research/framework/analyze', payload, {
      signal,
      timeout: 0,
    });
    return response.data;
  }

  async createResearchFrameworkFigure(payload, signal) {
    const response = await this.client.post('/research/framework/figures', payload, {
      signal,
      timeout: 0,
    });
    return response.data;
  }

  getResearchArtifactUrl(path) {
    return this.getOperationExportUrl(path);
  }

  async validateOperationCode(code, signal) {
    const response = await this.client.post('/operations/validate', { code }, { signal });
    return response.data;
  }

  async planOperation(selection, signal) {
    const response = await this.client.post('/operations/plan', { selection }, { signal });
    return response.data;
  }

  async runOperation(payload, signal) {
    const response = await this.client.post('/operations/run', payload, {
      signal,
      timeout: 0,
    });
    return response.data;
  }

  async submitOperationJob(payload, signal) {
    const response = await this.client.post('/operations/jobs', payload, {
      signal,
      timeout: 0,
    });
    return response.data;
  }

  async getOperationJob(jobId, signal) {
    return this.getWithCache(`/operations/jobs/${encodeURIComponent(jobId)}`, {}, { signal, cache: false });
  }

  async cancelOperationJob(jobId, signal) {
    const response = await this.client.post(`/operations/jobs/${encodeURIComponent(jobId)}/cancel`, {}, { signal });
    return response.data;
  }

  getOperationExportUrl(downloadUrl) {
    if (!downloadUrl) return '';
    if (downloadUrl.startsWith('http://') || downloadUrl.startsWith('https://')) {
      return downloadUrl;
    }
    const base = this.client.defaults.baseURL.replace(/\/+$/, '');
    const path = downloadUrl.startsWith('/') ? downloadUrl : `/${downloadUrl}`;
    return `${base}${path}`;
  }

  clearCache() {
    this.cache.clear();
    this.cacheWeight = 0;
    this.cacheGeneration += 1;
  }
}

export default new APIService();
