import axios from 'axios';

const API_BASE_URL = 'http://127.0.0.1:8000';

class APIService {
  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: 60000,
    });

    this.cache = new Map();
    this.maxCacheSize = 80;
  }

  getCacheKey(endpoint, params) {
    return `${endpoint}?${JSON.stringify(params)}`;
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
    const shouldUseCache = !config?.signal;
    const cacheKey = this.getCacheKey(endpoint, params);

    if (shouldUseCache && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    const response = await this.client.get(endpoint, { params, ...config });

    if (shouldUseCache) {
      this.cache.set(cacheKey, response.data);
      if (this.cache.size > this.maxCacheSize) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
    }

    return response.data;
  }

  async getDatasets() {
    return this.getWithCache('/datasets');
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

  async getData(date, elevMin, elevMax, variable, dataset, signal, yearRange) {
    return this.getWithCache(
      '/data',
      this.withContext(
        {
          date,
          elev_min: elevMin,
          elev_max: elevMax,
          variable,
        },
        dataset,
        yearRange
      ),
      { signal }
    );
  }

  async getBasinMean(startDate, endDate, elevMin, elevMax, variable, dataset, signal, yearRange) {
    return this.getWithCache(
      '/basin-mean',
      this.withContext(
        {
          start_date: startDate,
          end_date: endDate,
          elev_min: elevMin,
          elev_max: elevMax,
          variable,
        },
        dataset,
        yearRange
      ),
      { signal }
    );
  }

  async getRegionMean(year, bounds, elevMin, elevMax, variable, dataset, signal, yearRange) {
    return this.getWithCache(
      '/region-mean',
      this.withContext(
        {
          year,
          min_lat: bounds.minLat,
          max_lat: bounds.maxLat,
          min_lon: bounds.minLon,
          max_lon: bounds.maxLon,
          elev_min: elevMin,
          elev_max: elevMax,
          variable,
        },
        dataset,
        yearRange
      ),
      { signal }
    );
  }

  async getStats(dataset, yearRange) {
    return this.getWithCache('/stats', this.withContext({}, dataset, yearRange));
  }

  clearCache() {
    this.cache.clear();
  }
}

export default new APIService();
