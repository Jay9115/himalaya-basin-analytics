import React, { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { Map } from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';

const INITIAL_VIEW_STATE = {
  // Start with full-India view so PMTiles admin boundaries are visible immediately.
  longitude: 79.5,
  latitude: 22.8,
  zoom: 3.9,
  pitch: 0,
  bearing: 0,
};

const INDIA_BOUNDARY_SOURCE_ID = 'india-admin-boundary-source';
const INDIA_STATE_LAYER_ID = 'india-admin-state-boundary-line';
const INDIA_DISTRICT_LAYER_ID = 'india-admin-district-boundary-line';
const INDIA_STATE_LABEL_LAYER_ID = 'india-admin-state-label';
const INDIA_DISTRICT_LABEL_LAYER_ID = 'india-admin-district-label';
const indiaPmBounds = [68.17751186879357, 6.752782631992444, 97.41289651394189, 37.08834177335065];
const indiaPmMaxZoom = 13;

const trimTrailingSlash = (value) => value.replace(/\/+$/, '');

const toPmtilesUrl = (value, apiBaseUrl) => {
  if (!value) {
    return `pmtiles://${apiBaseUrl}/map-assets/india_admin.pmtiles`;
  }
  if (value.startsWith('pmtiles://')) return value;
  if (value.startsWith('http://') || value.startsWith('https://')) {
    return `pmtiles://${value}`;
  }
  if (value.startsWith('/')) {
    return `pmtiles://${apiBaseUrl}${value}`;
  }
  return `pmtiles://${apiBaseUrl}/${value}`;
};
const buildOfflineBaseStyle = (theme, glyphsUrl) => {
  const style = {
    version: 8,
    name: 'Offline Base Style',
    sources: {},
    layers: [
      {
        id: 'offline-background',
        type: 'background',
        paint: {
          'background-color': theme === 'dark' ? '#080b12' : '#eef3f8',
        },
      },
    ],
  };

  if (glyphsUrl) {
    style.glyphs = glyphsUrl;
  }

  return style;
};

const pmtilesProtocol = new Protocol();
let pmtilesProtocolRegistered = false;
if (!pmtilesProtocolRegistered) {
  try {
    maplibregl.addProtocol('pmtiles', pmtilesProtocol.tile);
  } catch (error) {
    if (!String(error?.message || '').toLowerCase().includes('protocol')) {
      throw error;
    }
  }
  pmtilesProtocolRegistered = true;
}

const findFirstSymbolLayer = (map) => {
  const layers = map.getStyle()?.layers || [];
  const firstSymbol = layers.find((layer) => layer.type === 'symbol');
  return firstSymbol?.id;
};

const shouldHideBaseLayer = (layerId, layerType) => {
  if (!layerId) return false;
  if (layerId.startsWith('india-admin-')) return false;
  if (layerType === 'symbol') return true;
  if (layerType !== 'line') return false;

  const id = layerId.toLowerCase();
  return id.includes('admin') || id.includes('boundary') || id.includes('border');
};

const paletteStops = {
  viridis: [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ],
  magma: [
    [0, 0, 4],
    [80, 18, 123],
    [182, 54, 121],
    [251, 136, 97],
    [252, 253, 191],
  ],
  turbo: [
    [48, 18, 59],
    [50, 101, 222],
    [50, 216, 164],
    [251, 210, 73],
    [180, 4, 38],
  ],
  blue_red: [
    [43, 120, 190],
    [255, 255, 255],
    [202, 0, 32],
  ],
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

const getPaletteStops = (style, fallback = 'viridis') => {
  if (style?.palette) {
    return paletteStops[String(style.palette).toLowerCase()] || paletteStops[fallback] || paletteStops.viridis;
  }
  return paletteStops[fallback] || paletteStops.viridis;
};

const parseColor = (color, alpha) => {
  if (Array.isArray(color) && color.length >= 3) {
    return [
      Number(color[0]) || 0,
      Number(color[1]) || 0,
      Number(color[2]) || 0,
      Number.isFinite(Number(color[3])) ? Number(color[3]) : alpha,
    ];
  }
  if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) {
    return [
      Number.parseInt(color.slice(1, 3), 16),
      Number.parseInt(color.slice(3, 5), 16),
      Number.parseInt(color.slice(5, 7), 16),
      alpha,
    ];
  }
  return null;
};

const interpolateColor = (stops, ratio, alpha) => {
  const safeStops = stops && stops.length >= 2 ? stops : paletteStops.viridis;
  const scaled = clamp01(ratio) * (safeStops.length - 1);
  const lower = Math.floor(scaled);
  const upper = Math.min(safeStops.length - 1, lower + 1);
  const local = scaled - lower;
  const color = [0, 1, 2].map((index) => Math.round(
    safeStops[lower][index] + (safeStops[upper][index] - safeStops[lower][index]) * local
  ));
  return [...color, alpha];
};

const getColorForValue = (value, min, max, style = null) => {
  const alpha = Math.round(clamp01(Number(style?.opacity ?? 0.78)) * 255);
  if (!Number.isFinite(value)) return [120, 120, 120, 80];
  const fixedColor = parseColor(style?.color, alpha);
  if (fixedColor) return fixedColor;
  const palette = getPaletteStops(style, 'viridis');
  const styledMin = Number.isFinite(Number(style?.vmin)) ? Number(style.vmin) : min;
  const styledMax = Number.isFinite(Number(style?.vmax)) ? Number(style.vmax) : max;
  const ratio = styledMax <= styledMin ? 0.5 : (value - styledMin) / (styledMax - styledMin);
  return interpolateColor(palette, ratio, alpha);
};

const getColorForTrend = (value, maxAbs) => {
  if (!Number.isFinite(value) || !Number.isFinite(maxAbs) || maxAbs <= 0) {
    return [140, 140, 140, 140];
  }
  const normalized = Math.max(-1, Math.min(1, value / maxAbs));
  return interpolateColor(paletteStops.blue_red, (normalized + 1) / 2, 220);
};

const getDatumValue = (item) => {
  if (!item) return NaN;
  if (Number.isFinite(item.value)) return item.value;
  const propValue = item.properties?.value;
  return Number.isFinite(propValue) ? propValue : Number(propValue);
};

const isGeoJsonFeature = (item) => item?.type === 'Feature' && item?.geometry;

const getGlacierMaxFeaturesForZoom = (zoom) => {
  if (zoom >= 10) return 5000;
  if (zoom >= 8) return 3200;
  if (zoom >= 6.5) return 1800;
  return 1000;
};
const MIN_GLACIER_VIEW_ZOOM = 3.5;

function MapView({
  data,
  currentDate,
  theme,
  variableLabel,
  selectionEnabled,
  onSelectionComplete,
  onSelectionPreview,
  selectionBounds,
  selectedSubregionFeature,
  glacierViewEnabled = false,
  focusLocation,
  analysisMode = 'daily',
  hotspotSummary = null,
  layerStyle = null,
}) {
  const lightStyleOverride = import.meta.env.VITE_MAP_STYLE_LIGHT;
  const darkStyleOverride = import.meta.env.VITE_MAP_STYLE_DARK;
  const apiBaseUrl = useMemo(() => {
    const explicitApiUrl = import.meta.env.VITE_API_URL;
    if (explicitApiUrl) {
      return trimTrailingSlash(explicitApiUrl);
    }
    // In local Vite dev, frontend runs on a different port than FastAPI.
    if (import.meta.env.DEV) {
      return 'http://127.0.0.1:8000';
    }
    if (typeof window !== 'undefined' && window.location?.origin) {
      return trimTrailingSlash(window.location.origin);
    }
    return 'http://127.0.0.1:8000';
  }, []);

  const pmtilesUrl = useMemo(
    () => toPmtilesUrl(import.meta.env.VITE_INDIA_PM_TILES_URL, apiBaseUrl),
    [apiBaseUrl]
  );
  const basinGeoJsonUrl = import.meta.env.VITE_BASIN_GEOJSON_URL || `${apiBaseUrl}/map-assets/upper_indus_basin.geojson`;
  const glyphsUrl = import.meta.env.VITE_GLYPHS_URL || `${apiBaseUrl}/map-assets/fonts/{fontstack}/{range}.pbf`;
  const pmtilesTilesTemplate = useMemo(() => {
    const normalized = pmtilesUrl.endsWith('/') ? pmtilesUrl.slice(0, -1) : pmtilesUrl;
    return `${normalized}/{z}/{x}/{y}`;
  }, [pmtilesUrl]);

  const mapStyle = useMemo(() => {
    if (theme === 'light') {
      return lightStyleOverride || buildOfflineBaseStyle('light', glyphsUrl);
    }
    return darkStyleOverride || buildOfflineBaseStyle('dark', glyphsUrl);
  }, [theme, lightStyleOverride, darkStyleOverride, glyphsUrl]);

  const containerRef = useRef(null);
  const deckRef = useRef(null);
  const mapRef = useRef(null);
  const [viewState, setViewState] = useState(INITIAL_VIEW_STATE);
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [basinGeoJson, setBasinGeoJson] = useState(null);
  const [glacierGeoJson, setGlacierGeoJson] = useState(null);
  const [glacierMeta, setGlacierMeta] = useState(null);
  const glacierAbortRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    const loadBasinBoundary = async () => {
      try {
        const separator = basinGeoJsonUrl.includes('?') ? '&' : '?';
        const requestUrl = `${basinGeoJsonUrl}${separator}_ts=${Date.now()}`;
        const response = await fetch(requestUrl, {
          signal: controller.signal,
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const json = await response.json();
        setBasinGeoJson(json);
      } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error('Failed to load basin boundary GeoJSON:', error);
        setBasinGeoJson(null);
      }
    };

    loadBasinBoundary();
    return () => controller.abort();
  }, [basinGeoJsonUrl]);

  useEffect(() => {
    if (!glacierViewEnabled) {
      glacierAbortRef.current?.abort?.();
      setGlacierGeoJson(null);
      setGlacierMeta(null);
      return;
    }
    if (!mapLoaded) return;
    if (viewState.zoom < MIN_GLACIER_VIEW_ZOOM) {
      glacierAbortRef.current?.abort?.();
      setGlacierGeoJson({ type: 'FeatureCollection', features: [] });
      setGlacierMeta({
        count: 0,
        truncated: false,
        zoom: viewState.zoom,
        zoom_limited: true,
        minimum_zoom: MIN_GLACIER_VIEW_ZOOM,
      });
      return;
    }

    const map = mapRef.current?.getMap?.();
    if (!map) return;
    const bounds = map.getBounds?.();
    if (!bounds) return;

    const maxFeatures = getGlacierMaxFeaturesForZoom(viewState.zoom);
    const params = new URLSearchParams({
      min_lat: String(bounds.getSouth()),
      max_lat: String(bounds.getNorth()),
      min_lon: String(bounds.getWest()),
      max_lon: String(bounds.getEast()),
      zoom: String(viewState.zoom),
      max_features: String(maxFeatures),
    });
    const requestUrl = `${apiBaseUrl}/glaciers/overview?${params.toString()}`;

    const controller = new AbortController();
    if (glacierAbortRef.current) {
      glacierAbortRef.current.abort();
    }
    glacierAbortRef.current = controller;

    const timer = setTimeout(async () => {
      const fetchGlacierPayload = async (allowRetry) => {
        const response = await fetch(requestUrl, {
          signal: controller.signal,
          cache: 'no-store',
        });
        const contentType = response.headers.get('content-type') || '';

        if (!response.ok) {
          let detailText = '';
          try {
            if (contentType.toLowerCase().includes('application/json')) {
              const body = await response.json();
              detailText = body?.detail || JSON.stringify(body);
            } else {
              detailText = await response.text();
            }
          } catch {
            detailText = '';
          }

          if (allowRetry && response.status >= 500 && response.status < 600) {
            await new Promise((resolve) => setTimeout(resolve, 180));
            return fetchGlacierPayload(false);
          }

          const shortDetail = String(detailText || '').trim().slice(0, 180);
          throw new Error(shortDetail ? `HTTP ${response.status}: ${shortDetail}` : `HTTP ${response.status}`);
        }

        if (!contentType.toLowerCase().includes('application/json')) {
          throw new Error(`Expected JSON from glacier API, got '${contentType || 'unknown'}'`);
        }
        return response.json();
      };

      try {
        const payload = await fetchGlacierPayload(true);
        if (controller.signal.aborted) return;
        const featureCollection = payload?.feature_collection;
        if (featureCollection?.type === 'FeatureCollection') {
          setGlacierGeoJson(featureCollection);
          setGlacierMeta(payload?.meta || null);
        } else {
          setGlacierGeoJson({ type: 'FeatureCollection', features: [] });
          setGlacierMeta(payload?.meta || null);
        }
      } catch (error) {
        if (error?.name === 'AbortError') return;
        console.error('Failed to load glacier overview:', error);
        if (!controller.signal.aborted) {
          setGlacierGeoJson({ type: 'FeatureCollection', features: [] });
          setGlacierMeta(null);
        }
      }
    }, 180);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [glacierViewEnabled, mapLoaded, apiBaseUrl, viewState.longitude, viewState.latitude, viewState.zoom]);

  const applyIndiaBoundaryLayer = useCallback(() => {
    const map = mapRef.current?.getMap?.();
    if (!map || !map.isStyleLoaded()) return;

    const stateLineColor = theme === 'dark' ? '#7e6f62' : '#8a7d72';
    const districtLineColor = theme === 'dark' ? '#66594f' : '#9f9388';
    const stateLabelColor = theme === 'dark' ? '#d3c7bc' : '#5f5146';
    const districtLabelColor = theme === 'dark' ? '#c5b7aa' : '#726458';
    const labelHalo = theme === 'dark' ? '#0f1218' : '#f3f4f6';
    const beforeId = findFirstSymbolLayer(map);
    const addLayer = (layerConfig, beforeLayerId) => {
      if (beforeLayerId) {
        map.addLayer(layerConfig, beforeLayerId);
      } else {
        map.addLayer(layerConfig);
      }
    };

    const styleLayers = map.getStyle()?.layers || [];
    const hasGlyphs = Boolean(map.getStyle()?.glyphs);
    for (const layer of styleLayers) {
      if (shouldHideBaseLayer(layer.id, layer.type)) {
        try {
          map.setLayoutProperty(layer.id, 'visibility', 'none');
        } catch (error) {
          console.warn(`Could not hide base layer "${layer.id}"`, error);
        }
      }
    }

    if (!map.getSource(INDIA_BOUNDARY_SOURCE_ID)) {
      map.addSource(INDIA_BOUNDARY_SOURCE_ID, {
        type: 'vector',
        // Use explicit tiles template instead of `url` TileJSON fetch.
        // Some PMTiles archives can have invalid header bounds while tile data is valid.
        // With explicit bounds+tiles we keep India layer visible at all zoom levels.
        tiles: [pmtilesTilesTemplate],
        minzoom: 0,
        maxzoom: indiaPmMaxZoom,
        bounds: indiaPmBounds,
      });
    }

    if (!map.getLayer(INDIA_STATE_LAYER_ID)) {
      addLayer(
        {
          id: INDIA_STATE_LAYER_ID,
          type: 'line',
          source: INDIA_BOUNDARY_SOURCE_ID,
          'source-layer': 'state_boundary',
          paint: {
            'line-color': stateLineColor,
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.55, 10, 1.15],
            'line-opacity': 0.62,
          },
        },
        beforeId
      );
    }

    if (!map.getLayer(INDIA_DISTRICT_LAYER_ID)) {
      addLayer(
        {
          id: INDIA_DISTRICT_LAYER_ID,
          type: 'line',
          source: INDIA_BOUNDARY_SOURCE_ID,
          'source-layer': 'district_boundary',
          minzoom: 5,
          paint: {
            'line-color': districtLineColor,
            'line-width': ['interpolate', ['linear'], ['zoom'], 5, 0.12, 10, 0.45],
            'line-opacity': 0.35,
          },
        },
        beforeId
      );
    }

    if (hasGlyphs) {
      if (!map.getLayer(INDIA_STATE_LABEL_LAYER_ID)) {
        addLayer(
          {
            id: INDIA_STATE_LABEL_LAYER_ID,
            type: 'symbol',
            source: INDIA_BOUNDARY_SOURCE_ID,
            'source-layer': 'state_hq',
            minzoom: 4,
            layout: {
              'text-field': ['coalesce', ['get', 'state_name'], ''],
              'text-font': ['Noto Sans Regular'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 4, 10, 9, 13],
              'text-allow-overlap': false,
            },
            paint: {
              'text-color': stateLabelColor,
              'text-halo-color': labelHalo,
              'text-halo-width': 1.1,
            },
          }
        );
      }

      if (!map.getLayer(INDIA_DISTRICT_LABEL_LAYER_ID)) {
        addLayer(
          {
            id: INDIA_DISTRICT_LABEL_LAYER_ID,
            type: 'symbol',
            source: INDIA_BOUNDARY_SOURCE_ID,
            'source-layer': 'district_hq',
            minzoom: 6,
            layout: {
              'text-field': ['coalesce', ['get', 'district_name'], ['get', 'hq_name'], ''],
              'text-font': ['Noto Sans Regular'],
              'text-size': ['interpolate', ['linear'], ['zoom'], 6, 9, 10, 11.5],
              'text-allow-overlap': false,
            },
            paint: {
              'text-color': districtLabelColor,
              'text-halo-color': labelHalo,
              'text-halo-width': 0.9,
            },
          }
        );
      }
    }

    if (map.getLayer(INDIA_STATE_LAYER_ID)) {
      map.setPaintProperty(INDIA_STATE_LAYER_ID, 'line-color', stateLineColor);
    }
    if (map.getLayer(INDIA_DISTRICT_LAYER_ID)) {
      map.setPaintProperty(INDIA_DISTRICT_LAYER_ID, 'line-color', districtLineColor);
    }
    if (hasGlyphs) {
      if (map.getLayer(INDIA_STATE_LABEL_LAYER_ID)) {
        map.setPaintProperty(INDIA_STATE_LABEL_LAYER_ID, 'text-color', stateLabelColor);
        map.setPaintProperty(INDIA_STATE_LABEL_LAYER_ID, 'text-halo-color', labelHalo);
      }
      if (map.getLayer(INDIA_DISTRICT_LABEL_LAYER_ID)) {
        map.setPaintProperty(INDIA_DISTRICT_LABEL_LAYER_ID, 'text-color', districtLabelColor);
        map.setPaintProperty(INDIA_DISTRICT_LABEL_LAYER_ID, 'text-halo-color', labelHalo);
      }
    }
  }, [pmtilesTilesTemplate, theme]);

  const handleMapLoad = useCallback(() => {
    setMapLoaded(true);
    try {
      applyIndiaBoundaryLayer();
    } catch (error) {
      console.error('Failed to add India PMTiles layer:', error);
    }
  }, [applyIndiaBoundaryLayer]);

  const handleMapStyleData = useCallback(() => {
    try {
      applyIndiaBoundaryLayer();
    } catch (error) {
      console.error('Failed to refresh India PMTiles layer:', error);
    }
  }, [applyIndiaBoundaryLayer]);

  useEffect(() => {
    if (!focusLocation) return;
    setViewState((prev) => ({
      ...prev,
      longitude: focusLocation.lon,
      latitude: focusLocation.lat,
      transitionDuration: 600,
    }));
  }, [focusLocation]);

  const valueRange = useMemo(() => {
    if (!data || data.length === 0) {
      return { min: 0, max: 1 };
    }
    const styledMin = Number(layerStyle?.vmin);
    const styledMax = Number(layerStyle?.vmax);
    if (Number.isFinite(styledMin) && Number.isFinite(styledMax) && styledMin < styledMax) {
      return { min: styledMin, max: styledMax };
    }
    let min = Infinity;
    let max = -Infinity;
    for (const point of data) {
      const value = getDatumValue(point);
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (min === Infinity || max === -Infinity) {
      return { min: 0, max: 1 };
    }
    if (min === max) {
      return { min, max: min + 1 };
    }
    return { min, max };
  }, [data, layerStyle]);

  const trendRange = useMemo(() => {
    if (analysisMode !== 'hotspot' || !data || data.length === 0) {
      return { maxAbs: 1 };
    }
    let maxAbs = 0;
    for (const point of data) {
      const slope = point?.slope_per_year;
      if (!Number.isFinite(slope)) continue;
      const absValue = Math.abs(slope);
      if (absValue > maxAbs) maxAbs = absValue;
    }
    return { maxAbs: maxAbs > 0 ? maxAbs : 1 };
  }, [analysisMode, data]);

  const legendPalette = useMemo(() => {
    if (analysisMode === 'hotspot') {
      return paletteStops.blue_red;
    }
    return getPaletteStops(layerStyle, 'viridis');
  }, [analysisMode, layerStyle]);

  const legendRange = useMemo(() => {
    if (analysisMode === 'hotspot') {
      const maxAbs = trendRange.maxAbs;
      return {
        min: -maxAbs,
        mid: 0,
        max: maxAbs,
      };
    }
    return {
      min: valueRange.min,
      mid: valueRange.min + ((valueRange.max - valueRange.min) / 2),
      max: valueRange.max,
    };
  }, [analysisMode, trendRange.maxAbs, valueRange.min, valueRange.max]);

  const legendGradient = useMemo(() => {
    const safeStops = legendPalette && legendPalette.length >= 2 ? legendPalette : paletteStops.viridis;
    const step = 100 / (safeStops.length - 1);
    return `linear-gradient(90deg, ${safeStops
      .map(([r, g, b], index) => `rgb(${r}, ${g}, ${b}) ${Math.round(index * step)}%`)
      .join(', ')})`;
  }, [legendPalette]);

  const layers = useMemo(() => {
    const result = [];
    const featureData = (data || []).filter(isGeoJsonFeature);
    const pointData = (data || []).filter((item) => !isGeoJsonFeature(item));

    if (!glacierViewEnabled && basinGeoJson) {
      result.push(
        new GeoJsonLayer({
          id: 'upper-indus-basin-boundary',
          data: basinGeoJson,
          stroked: true,
          filled: true,
          pickable: false,
          getFillColor: theme === 'dark' ? [70, 150, 180, 6] : [35, 110, 140, 8],
          getLineColor: theme === 'dark' ? [130, 185, 215, 150] : [45, 100, 130, 165],
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 1,
          lineWidthMaxPixels: 2,
          getLineWidth: 1.0,
          parameters: { depthTest: false },
        })
      );
    }

    if (glacierViewEnabled && glacierGeoJson) {
      result.push(
        new GeoJsonLayer({
          id: 'glacier-overview-layer',
          data: glacierGeoJson,
          stroked: true,
          filled: true,
          pickable: true,
          autoHighlight: false,
          getFillColor: theme === 'dark' ? [166, 223, 255, 36] : [118, 191, 236, 42],
          getLineColor: theme === 'dark' ? [213, 240, 255, 165] : [58, 135, 194, 180],
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 0.7,
          lineWidthMaxPixels: 1.7,
          getLineWidth: 1.0,
          parameters: { depthTest: false },
        })
      );
    }

    if (selectedSubregionFeature) {
      result.push(
        new GeoJsonLayer({
          id: 'selected-subregion-boundary',
          data: selectedSubregionFeature,
          stroked: true,
          filled: true,
          pickable: false,
          getFillColor: theme === 'dark' ? [255, 190, 92, 26] : [255, 164, 52, 28],
          getLineColor: theme === 'dark' ? [255, 214, 145, 235] : [187, 96, 22, 230],
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 1.5,
          lineWidthMaxPixels: 4,
          getLineWidth: 2.1,
          parameters: { depthTest: false },
        })
      );
    }

    if (!data || data.length === 0) {
      return result;
    }

    if (featureData.length > 0) {
      result.push(
        new GeoJsonLayer({
          id: 'geoparquet-network-cells',
          data: {
            type: 'FeatureCollection',
            features: featureData,
          },
          pickable: true,
          stroked: true,
          filled: true,
          opacity: 0.86,
          getFillColor: (feature) => getColorForValue(getDatumValue(feature), valueRange.min, valueRange.max, layerStyle),
          getLineColor: theme === 'dark' ? [10, 16, 24, 80] : [255, 255, 255, 95],
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 0.05,
          lineWidthMaxPixels: 0.45,
          getLineWidth: 0.18,
          updateTriggers: {
            getFillColor: [valueRange.min, valueRange.max],
            getLineColor: [theme],
          },
          parameters: { depthTest: false },
        })
      );
    }

    if (pointData.length === 0) {
      return result;
    }

    const scatterLayer = new ScatterplotLayer({
      id: 'variable-scatter',
      data: pointData,
      pickable: true,
      opacity: analysisMode === 'hotspot' ? 0.82 : 0.7,
      stroked: false,
      filled: true,
      radiusScale: 1,
      radiusMinPixels: analysisMode === 'hotspot' ? 3 : 2,
      radiusMaxPixels: analysisMode === 'hotspot' ? 10 : 9,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: (d) => {
        if (d?.kind === 'discharge_network') return 520;
        if (analysisMode !== 'hotspot') return 300;
        const strength = Number.isFinite(d?.trend_strength) ? d.trend_strength : 0;
        const maxAbs = trendRange.maxAbs || 1;
        const normalized = Math.min(1, Math.max(0, strength / maxAbs));
        return 260 + normalized * 620;
      },
      getFillColor: (d) => (
        analysisMode === 'hotspot'
          ? getColorForTrend(d.slope_per_year, trendRange.maxAbs)
          : getColorForValue(getDatumValue(d), valueRange.min, valueRange.max, layerStyle)
      ),
      updateTriggers: {
        getFillColor: [analysisMode, valueRange.min, valueRange.max, trendRange.maxAbs, layerStyle],
        getRadius: [analysisMode, trendRange.maxAbs],
      },
      parameters: { depthTest: false },
    });

    result.push(scatterLayer);
    return result;
  }, [
    data,
    valueRange,
    basinGeoJson,
    glacierGeoJson,
    glacierViewEnabled,
    selectedSubregionFeature,
    theme,
    analysisMode,
    trendRange,
  ]);

  const deckController = useMemo(() => {
    if (selectionEnabled) return false;
    return {
      maxZoom: indiaPmMaxZoom,
    };
  }, [selectionEnabled]);

  const getTooltip = ({ object }) => {
    if (!object) return null;

    if (object?.properties?.kind === 'glacier') {
      const props = object.properties || {};
      const areaValue = Number(props.area_km2);
      const area = Number.isFinite(areaValue) ? `${areaValue.toFixed(3)} km²` : 'N/A';
      return {
        html: `
          <div style="background: var(--tooltip-bg); padding: 12px; border-radius: 8px; color: var(--text); border: 1px solid var(--tooltip-border);">
            <div style="margin-bottom: 8px; font-weight: bold; border-bottom: 1px solid var(--map-overlay-border); padding-bottom: 4px;">
              Glacier Outline
            </div>
            <div style="display: grid; grid-template-columns: auto 1fr; gap: 8px; font-size: 13px;">
              <span style="color: var(--text-muted);">Name:</span>
              <span>${props.glacier_name || 'Unnamed glacier'}</span>
              <span style="color: var(--text-muted);">RGI ID:</span>
              <span>${props.rgi_id || 'N/A'}</span>
              <span style="color: var(--text-muted);">Area:</span>
              <span>${area}</span>
            </div>
          </div>
        `,
        style: {
          backgroundColor: 'transparent',
          fontSize: '14px',
        },
      };
    }

    if (object?.properties?.kind === 'discharge_network' || object?.kind === 'discharge_network') {
      const props = object.properties || object || {};
      const value = getDatumValue(object);
      const lat = Number(props.lat);
      const lon = Number(props.lon);
      return {
        html: `
          <div style="background: var(--tooltip-bg); padding: 12px; border-radius: 8px; color: var(--text); border: 1px solid var(--tooltip-border);">
            <div style="margin-bottom: 8px; font-weight: bold; border-bottom: 1px solid var(--map-overlay-border); padding-bottom: 4px;">
              Discharge Network Cell
            </div>
            <div style="display: grid; grid-template-columns: auto 1fr; gap: 8px; font-size: 13px;">
              <span style="color: var(--text-muted);">Date:</span>
              <span>${props.date || currentDate}</span>
              <span style="color: var(--text-muted);">${variableLabel || props.variable || 'Value'}:</span>
              <span style="font-weight: bold;">${Number.isFinite(value) ? value.toFixed(2) : 'N/A'}</span>
              <span style="color: var(--text-muted);">Coordinates:</span>
              <span>${Number.isFinite(lat) ? lat.toFixed(4) : 'N/A'}N, ${Number.isFinite(lon) ? lon.toFixed(4) : 'N/A'}E</span>
            </div>
          </div>
        `,
        style: {
          backgroundColor: 'transparent',
          fontSize: '14px',
        },
      };
    }

    if (analysisMode === 'hotspot') {
      return {
        html: `
          <div style="background: var(--tooltip-bg); padding: 12px; border-radius: 8px; color: var(--text); border: 1px solid var(--tooltip-border);">
            <div style="margin-bottom: 8px; font-weight: bold; border-bottom: 1px solid var(--map-overlay-border); padding-bottom: 4px;">
              Long-Term Hotspot
            </div>
            <div style="display: grid; grid-template-columns: auto 1fr; gap: 8px; font-size: 13px;">
              <span style="color: var(--text-muted);">Years:</span>
              <span>${object.start_year} to ${object.end_year}</span>

              <span style="color: var(--text-muted);">Slope / year:</span>
              <span style="font-weight: bold;">${Number.isFinite(object.slope_per_year) ? object.slope_per_year.toFixed(4) : 'N/A'}</span>

              <span style="color: var(--text-muted);">Total change:</span>
              <span>${Number.isFinite(object.total_change) ? object.total_change.toFixed(3) : 'N/A'}</span>

              <span style="color: var(--text-muted);">Hotspot level:</span>
              <span>${object.hotspot_level || 'N/A'}</span>

              <span style="color: var(--text-muted);">Coverage:</span>
              <span>${Number.isFinite(object.coverage_years) ? object.coverage_years : 'N/A'} years</span>

              <span style="color: var(--text-muted);">Coordinates:</span>
              <span>${Number.isFinite(object.lat) ? object.lat.toFixed(4) : 'N/A'}N, ${Number.isFinite(object.lon) ? object.lon.toFixed(4) : 'N/A'}E</span>
            </div>
          </div>
        `,
        style: {
          backgroundColor: 'transparent',
          fontSize: '14px',
        },
      };
    }

    return {
      html: `
        <div style="background: var(--tooltip-bg); padding: 12px; border-radius: 8px; color: var(--text); border: 1px solid var(--tooltip-border);">
          <div style="margin-bottom: 8px; font-weight: bold; border-bottom: 1px solid var(--map-overlay-border); padding-bottom: 4px;">
            Location Data
          </div>
          <div style="display: grid; grid-template-columns: auto 1fr; gap: 8px; font-size: 13px;">
            <span style="color: var(--text-muted);">Date:</span>
            <span>${currentDate}</span>
            
            <span style="color: var(--text-muted);">${variableLabel || 'Value'}:</span>
            <span style="color: var(--text); font-weight: bold;">
              ${Number.isFinite(object.value) ? object.value.toFixed(2) : 'N/A'}
            </span>
            
            <span style="color: var(--text-muted);">Elevation:</span>
            <span>${Number.isFinite(object.elev) ? object.elev.toFixed(0) : 'N/A'}m</span>
            
            <span style="color: var(--text-muted);">Coordinates:</span>
            <span>${object.lat.toFixed(4)}N, ${object.lon.toFixed(4)}E</span>
          </div>
        </div>
      `,
      style: {
        backgroundColor: 'transparent',
        fontSize: '14px',
      },
    };
  };

  const getLocalPoint = useCallback((event) => {
    if (!containerRef.current) return null;
    const rect = containerRef.current.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }, []);

  const getViewport = () => {
    const deckInstance = deckRef.current?.deck;
    if (deckInstance?.getViewports) {
      return deckInstance.getViewports()[0];
    }
    if (deckRef.current?.getViewports) {
      return deckRef.current.getViewports()[0];
    }
    return null;
  };

  const computeBoundsFromPixels = useCallback((start, end) => {
    const viewport = getViewport();
    if (!viewport) return null;

    const minX = Math.min(start.x, end.x);
    const maxX = Math.max(start.x, end.x);
    const minY = Math.min(start.y, end.y);
    const maxY = Math.max(start.y, end.y);

    const topLeft = viewport.unproject([minX, minY]);
    const bottomRight = viewport.unproject([maxX, maxY]);

    const minLon = Math.min(topLeft[0], bottomRight[0]);
    const maxLon = Math.max(topLeft[0], bottomRight[0]);
    const minLat = Math.min(topLeft[1], bottomRight[1]);
    const maxLat = Math.max(topLeft[1], bottomRight[1]);

    return { minLat, maxLat, minLon, maxLon };
  }, []);

  const finishSelection = useCallback(() => {
    if (!dragStart || !dragEnd) return;
    const dx = Math.abs(dragEnd.x - dragStart.x);
    const dy = Math.abs(dragEnd.y - dragStart.y);
    if (dx < 4 || dy < 4) {
      setIsDragging(false);
      setDragStart(null);
      setDragEnd(null);
      return;
    }

    const bounds = computeBoundsFromPixels(dragStart, dragEnd);
    if (!bounds) return;
    onSelectionComplete?.(bounds);

    setIsDragging(false);
    setDragStart(null);
    setDragEnd(null);
  }, [dragStart, dragEnd, onSelectionComplete]);

  const handleMouseDown = useCallback((event) => {
    if (!selectionEnabled) return;
    const point = getLocalPoint(event);
    if (!point) return;
    setDragStart(point);
    setDragEnd(point);
    setIsDragging(true);
  }, [selectionEnabled, getLocalPoint]);

  const handleMouseMove = useCallback((event) => {
    if (!selectionEnabled || !isDragging) return;
    const point = getLocalPoint(event);
    if (!point) return;
    setDragEnd(point);
    const bounds = computeBoundsFromPixels(dragStart, point);
    if (bounds) {
      onSelectionPreview?.(bounds);
    }
  }, [selectionEnabled, isDragging, getLocalPoint, dragStart, computeBoundsFromPixels, onSelectionPreview]);

  const handleMouseUp = useCallback(() => {
    if (!selectionEnabled || !isDragging) return;
    finishSelection();
  }, [selectionEnabled, isDragging, finishSelection]);

  const handleMouseLeave = useCallback(() => {
    if (!selectionEnabled || !isDragging) return;
    finishSelection();
  }, [selectionEnabled, isDragging, finishSelection]);

  const selectionBoxStyle = useMemo(() => {
    if (!dragStart || !dragEnd || !isDragging) return null;
    const left = Math.min(dragStart.x, dragEnd.x);
    const top = Math.min(dragStart.y, dragEnd.y);
    const width = Math.abs(dragEnd.x - dragStart.x);
    const height = Math.abs(dragEnd.y - dragStart.y);
    return { left, top, width, height };
  }, [dragStart, dragEnd, isDragging]);

  const persistentBoxStyle = useMemo(() => {
    if (!selectionBounds || isDragging) return null;
    const viewport = getViewport();
    if (!viewport) return null;

    const topLeft = viewport.project([selectionBounds.minLon, selectionBounds.maxLat]);
    const bottomRight = viewport.project([selectionBounds.maxLon, selectionBounds.minLat]);

    const left = Math.min(topLeft[0], bottomRight[0]);
    const top = Math.min(topLeft[1], bottomRight[1]);
    const width = Math.abs(bottomRight[0] - topLeft[0]);
    const height = Math.abs(bottomRight[1] - topLeft[1]);

    if (!Number.isFinite(left) || !Number.isFinite(top) || width <= 0 || height <= 0) {
      return null;
    }

    return { left, top, width, height };
  }, [selectionBounds, isDragging, viewState]);

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <DeckGL
        ref={deckRef}
        viewState={viewState}
        onViewStateChange={({ viewState: next }) => setViewState(next)}
        controller={deckController}
        layers={layers}
        getTooltip={getTooltip}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      >
        <Map
          ref={mapRef}
          mapStyle={mapStyle}
          attributionControl={false}
          maxZoom={indiaPmMaxZoom}
          onLoad={handleMapLoad}
          onStyleData={handleMapStyleData}
        />
      </DeckGL>

      <div
        style={{
          position: 'absolute',
          inset: 0,
          cursor: selectionEnabled ? 'crosshair' : 'grab',
          pointerEvents: selectionEnabled ? 'all' : 'none',
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />

      {selectionBoxStyle && (
        <div
          style={{
            position: 'absolute',
            left: selectionBoxStyle.left,
            top: selectionBoxStyle.top,
            width: selectionBoxStyle.width,
            height: selectionBoxStyle.height,
            border: '2px dashed var(--accent)',
            background: 'rgba(77, 171, 247, 0.15)',
            pointerEvents: 'none',
          }}
        />
      )}

      {persistentBoxStyle && (
        <div
          style={{
            position: 'absolute',
            left: persistentBoxStyle.left,
            top: persistentBoxStyle.top,
            width: persistentBoxStyle.width,
            height: persistentBoxStyle.height,
            border: '2px solid var(--accent)',
            boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.2)',
            background: 'rgba(77, 171, 247, 0.08)',
            pointerEvents: 'none',
          }}
        />
      )}

      <div style={{
        position: 'absolute',
        bottom: '20px',
        right: '20px',
        background: 'var(--map-overlay-bg)',
        padding: '15px',
        borderRadius: '8px',
        color: 'var(--map-overlay-text)',
        fontSize: '12px',
        backdropFilter: 'blur(10px)',
        border: '1px solid var(--map-overlay-border)',
      }}>
        <div style={{ fontWeight: 'bold', marginBottom: '10px' }}>
          {analysisMode === 'hotspot' ? 'Trend Hotspots (Slope / Year)' : `${variableLabel || 'Value'} Scale`}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div
            style={{
              height: '12px',
              borderRadius: '999px',
              background: legendGradient,
              border: '1px solid var(--map-overlay-border)',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '11px', color: 'var(--map-overlay-muted)' }}>
            <span>{legendRange.min.toFixed(3)}</span>
            <span>{legendRange.mid.toFixed(3)}</span>
            <span>{legendRange.max.toFixed(3)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', fontSize: '11px', color: 'var(--map-overlay-muted)' }}>
            <span>{analysisMode === 'hotspot' ? 'Decrease' : 'Low'}</span>
            <span>{analysisMode === 'hotspot' ? 'Neutral' : 'Mid'}</span>
            <span>{analysisMode === 'hotspot' ? 'Increase' : 'High'}</span>
          </div>
        </div>
        <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--map-overlay-border)', fontSize: '11px', color: 'var(--map-overlay-muted)' }}>
          {data.length.toLocaleString()} {analysisMode === 'hotspot' ? 'trend points' : 'data points'}
          {analysisMode === 'hotspot' && hotspotSummary?.hotspots_identified !== undefined && (
            <div style={{ marginTop: '6px' }}>
              Hotspots (high/extreme): {Number(hotspotSummary.hotspots_identified).toLocaleString()}
            </div>
          )}
          {glacierViewEnabled && (
            <div style={{ marginTop: '6px' }}>
              {glacierMeta?.zoom_limited
                ? `Glacier outlines: zoom in to ${Number(glacierMeta?.minimum_zoom || MIN_GLACIER_VIEW_ZOOM).toFixed(1)}+`
                : `Glacier outlines: ${Number(glacierMeta?.count || 0).toLocaleString()}${glacierMeta?.truncated ? ' (viewport cap reached)' : ''}`}
            </div>
          )}
        </div>
      </div>

      <div style={{
        position: 'absolute',
        top: '20px',
        left: '20px',
        background: 'var(--map-overlay-bg)',
        padding: '12px 20px',
        borderRadius: '8px',
        color: 'var(--map-overlay-text)',
        fontSize: '18px',
        fontWeight: 'bold',
        backdropFilter: 'blur(10px)',
        border: '1px solid var(--map-overlay-border)',
      }}>
        {analysisMode === 'hotspot' ? 'Long-Term Hotspot Analysis' : `Date: ${currentDate}`}
      </div>
    </div>
  );
}

export default React.memo(MapView);
