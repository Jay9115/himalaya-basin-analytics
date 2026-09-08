import React, { lazy, Suspense, useMemo, useRef, useState, useCallback, useEffect } from 'react';
import DeckGL from '@deck.gl/react';
import { GeoJsonLayer, IconLayer, ScatterplotLayer } from '@deck.gl/layers';
import { Map, Marker } from 'react-map-gl/maplibre';
import maplibregl from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import 'maplibre-gl/dist/maplibre-gl.css';

const SnapshotLayout = lazy(() => import('./SnapshotLayout'));

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

// Google Maps-style teardrop pin SVG (needle points down, white dot center)
const FOCUS_PIN_SVG_URL = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="128" viewBox="0 0 96 128">` +
  `<defs><filter id="s" x="-20%" y="-10%" width="140%" height="130%">` +
  `<feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.35"/>` +
  `</filter></defs>` +
  `<path d="M48 126 C48 126 8 72 8 44 A40 40 0 1 1 88 44 C88 72 48 126 48 126Z" ` +
  `fill="#EA4335" stroke="#B31412" stroke-width="1.5" filter="url(#s)"/>` +
  `<circle cx="48" cy="44" r="14" fill="#fff"/>` +
  `</svg>`
)}`;

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
          'background-color': theme === 'dark' ? '#11161b' : '#f8faf9',
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
  cividis: [
    [0, 34, 78],
    [50, 91, 121],
    [108, 127, 116],
    [172, 160, 105],
    [238, 205, 84],
  ],
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
  scientific_diverging: [
    [49, 54, 149],
    [116, 173, 209],
    [247, 247, 247],
    [244, 109, 67],
    [165, 0, 38],
  ],
  // --- Domain-specific palettes for spatial map coloring ---
  // Group 1: Magnitude / Amount — Light → Dark Blue
  magnitude_blue: [
    [224, 243, 254],
    [158, 213, 246],
    [80, 170, 224],
    [30, 113, 186],
    [8, 48, 107],
  ],
  // Group 2: Temperature / Thermal — Blue → Cyan → Yellow → Orange → Red
  temperature: [
    [43, 80, 188],
    [50, 190, 210],
    [255, 238, 88],
    [245, 152, 40],
    [204, 24, 30],
  ],
  // Group 3: Terrain / Surface — Green → Yellow → Brown → White
  terrain: [
    [30, 120, 50],
    [112, 168, 60],
    [225, 210, 100],
    [160, 110, 55],
    [248, 248, 248],
  ],
  // Group 4: Change / Anomaly — Blue → White → Red (diverging)
  change_anomaly: [
    [33, 102, 172],
    [146, 197, 222],
    [247, 247, 247],
    [239, 138, 98],
    [178, 24, 43],
  ],
};

// Classify a variable name into a palette group for automatic coloring
const VARIABLE_PALETTE_RULES = [
  // Group 4: Change / Anomaly (check first — anomaly keywords override base variable)
  {
    palette: 'change_anomaly',
    patterns: [
      'anomaly', 'change', 'trend', 'delta', 'deviation', 'difference',
      'percent_change', 'pct_change', '%_change', 'retreat', 'advance',
    ],
  },
  // Group 2: Temperature / Thermal
  {
    palette: 'temperature',
    patterns: [
      'temperature', 'temp', 'lst', 'land_surface_temp', 'air_temp',
      'surface_temp', 'sst', 'thermal', 'heat', 'tmax', 'tmin', 'tmean',
      't2m', 'skin_temp',
    ],
  },
  // Group 3: Terrain / Surface
  {
    palette: 'terrain',
    patterns: [
      'elevation', 'dem', 'altitude', 'slope', 'aspect', 'terrain',
      'topography', 'relief', 'albedo', 'roughness', 'curvature', 'height',
    ],
  },
  // Group 1: Magnitude / Amount (broadest — acts as default for hydro variables)
  {
    palette: 'magnitude_blue',
    patterns: [
      'precipitation', 'precip', 'rainfall', 'rain', 'runoff', 'discharge',
      'streamflow', 'soil_moisture', 'sm', 'snow', 'swe', 'snow_depth',
      'water', 'storage', 'evapotranspiration', 'et', 'evapo', 'transpiration',
      'groundwater', 'gw', 'baseflow', 'recharge', 'inflow', 'outflow',
      'humidity', 'moisture', 'ndvi', 'lai', 'ndsi', 'ndwi', 'twsa', 'glacier_area',
    ],
  },
];

const classifyVariablePalette = (variableLabel) => {
  if (!variableLabel) return null;
  const lower = String(variableLabel).toLowerCase().replace(/[^a-z0-9_%]/g, '_');
  for (const rule of VARIABLE_PALETTE_RULES) {
    for (const pattern of rule.patterns) {
      if (lower.includes(pattern)) return rule.palette;
    }
  }
  return null;
};

const clamp01 = (value) => Math.max(0, Math.min(1, value));

const getPaletteStops = (style, fallback = 'viridis', variableLabel = '') => {
  if (style?.palette) {
    return paletteStops[String(style.palette).toLowerCase()] || paletteStops[fallback] || paletteStops.cividis;
  }
  // Auto-select palette based on variable name when no explicit palette is set
  const autoPalette = classifyVariablePalette(variableLabel);
  if (autoPalette) {
    return paletteStops[autoPalette];
  }
  return paletteStops[fallback] || paletteStops.cividis;
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
  const safeStops = stops && stops.length >= 2 ? stops : paletteStops.cividis;
  const scaled = clamp01(ratio) * (safeStops.length - 1);
  const lower = Math.floor(scaled);
  const upper = Math.min(safeStops.length - 1, lower + 1);
  const local = scaled - lower;
  const color = [0, 1, 2].map((index) => Math.round(
    safeStops[lower][index] + (safeStops[upper][index] - safeStops[lower][index]) * local
  ));
  return [...color, alpha];
};

const getColorForValue = (value, min, max, style = null, variableLabel = '') => {
  const alpha = Math.round(clamp01(Number(style?.opacity ?? 0.78)) * 255);
  if (!Number.isFinite(value)) return [120, 120, 120, 80];
  const fixedColor = parseColor(style?.color, alpha);
  if (fixedColor) return fixedColor;
  const palette = getPaletteStops(style, 'cividis', variableLabel);
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
  return interpolateColor(paletteStops.scientific_diverging, (normalized + 1) / 2, 224);
};

const getDatumValue = (item) => {
  if (!item) return NaN;
  if (Number.isFinite(item.value)) return item.value;
  const propValue = item.properties?.value;
  return Number.isFinite(propValue) ? propValue : Number(propValue);
};

const isGeoJsonFeature = (item) => item?.type === 'Feature' && item?.geometry;

const inferRegularAxisStep = (values) => {
  const unique = Array.from(new Set(
    values
      .map((value) => Number(value))
      .filter(Number.isFinite)
      .map((value) => Number(value.toFixed(6)))
  )).sort((a, b) => a - b);
  if (unique.length < 3) return null;
  const differences = [];
  for (let index = 1; index < unique.length; index += 1) {
    const difference = unique[index] - unique[index - 1];
    if (difference > 1e-6) differences.push(difference);
  }
  if (differences.length < 2) return null;
  differences.sort((a, b) => a - b);
  const candidate = differences[Math.floor(differences.length * 0.25)];
  if (!Number.isFinite(candidate) || candidate <= 0) return null;
  const regularity = differences.filter((difference) => {
    const multiple = difference / candidate;
    return Math.abs(multiple - Math.round(multiple)) <= 0.08;
  }).length / differences.length;
  return regularity >= 0.72 ? candidate : null;
};

const inferRegularGridResolution = (points) => {
  if (!points || points.length < 16) return null;
  const longitudeStep = inferRegularAxisStep(points.map((point) => point?.lon));
  const latitudeStep = inferRegularAxisStep(points.map((point) => point?.lat));
  if (!longitudeStep || !latitudeStep) return null;
  return { longitudeStep, latitudeStep };
};

const getGlacierMaxFeaturesForZoom = (zoom) => {
  if (zoom >= 10) return 5000;
  if (zoom >= 8) return 3200;
  if (zoom >= 6.5) return 1800;
  return 1000;
};
const MIN_GLACIER_VIEW_ZOOM = 3.5;
const SELECTED_REGION_GLACIER_MAX_FEATURES = 20000;

function MapView({
  data,
  currentDate,
  theme,
  variableLabel,
  selectedSubregionFeature,
  glacierViewEnabled = false,
  glacierFilterBounds = null,
  glacierFilterAoi = null,
  glacierFilterSubregionId,
  focusLocations = [],
  onUpdateFocusLocation,
  onRemoveFocusLocation,
  analysisMode = 'daily',
  hotspotSummary = null,
  layerStyle = null,
  atlasRegions = [],
  selectionOnly = false,
  initialViewState = null,
  polygonDrawEnabled = false,
  onPolygonDrawToggle,
  onAoiComplete,
  aoiPolygons = [],
  selectedAoiId = '',
  onAoiSelect,
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
  const [viewState, setViewState] = useState(() => initialViewState || INITIAL_VIEW_STATE);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [snapshotOpen, setSnapshotOpen] = useState(false);
  const [basinGeoJson, setBasinGeoJson] = useState(null);
  const [glacierGeoJson, setGlacierGeoJson] = useState(null);
  const [glacierMeta, setGlacierMeta] = useState(null);
  const [draftAoiPoints, setDraftAoiPoints] = useState([]);
  const glacierAbortRef = useRef(null);
  const viewStateRef = useRef(viewState);
  const atlasOriginalViewRef = useRef(null);
  const atlasFeatureRef = useRef(null);

  useEffect(() => {
    viewStateRef.current = viewState;
  }, [viewState]);

  useEffect(() => {
    if (!polygonDrawEnabled && draftAoiPoints.length) {
      setDraftAoiPoints([]);
    }
  }, [polygonDrawEnabled, draftAoiPoints.length]);

  useEffect(() => {
    const controller = new AbortController();
    const loadBasinBoundary = async () => {
      try {
        const response = await fetch(basinGeoJsonUrl, {
          signal: controller.signal,
          cache: 'force-cache',
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
    const roiBounds = glacierFilterAoi?.analysis?.bounds || null;
    const hasRoiFilter = Boolean(glacierFilterAoi?.geometry && roiBounds);
    const hasRegionFilter = hasRoiFilter || Boolean(glacierFilterBounds);
    if (!hasRegionFilter && viewState.zoom < MIN_GLACIER_VIEW_ZOOM) {
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
    const viewportBounds = map.getBounds?.();
    if (!hasRegionFilter && !viewportBounds) return;

    const requestBounds = hasRoiFilter
      ? {
        south: roiBounds.minLat,
        north: roiBounds.maxLat,
        west: roiBounds.minLon,
        east: roiBounds.maxLon,
      }
      : hasRegionFilter
        ? {
          south: glacierFilterBounds.minLat,
          north: glacierFilterBounds.maxLat,
          west: glacierFilterBounds.minLon,
          east: glacierFilterBounds.maxLon,
        }
        : {
          south: viewportBounds.getSouth(),
          north: viewportBounds.getNorth(),
          west: viewportBounds.getWest(),
          east: viewportBounds.getEast(),
        };
    const maxFeatures = hasRegionFilter
      ? SELECTED_REGION_GLACIER_MAX_FEATURES
      : getGlacierMaxFeaturesForZoom(viewState.zoom);
    const params = new URLSearchParams({
      min_lat: String(requestBounds.south),
      max_lat: String(requestBounds.north),
      min_lon: String(requestBounds.west),
      max_lon: String(requestBounds.east),
      zoom: String(viewState.zoom),
      max_features: String(maxFeatures),
    });
    if (hasRegionFilter) {
      params.set('complete_within_bbox', 'true');
    }
    if (hasRoiFilter) {
      params.set('aoi_geojson', JSON.stringify({
        type: 'Feature',
        properties: {
          id: glacierFilterAoi.id,
          label: glacierFilterAoi.name || glacierFilterAoi.label || 'ROI',
        },
        geometry: glacierFilterAoi.geometry,
      }));
    } else if (glacierFilterSubregionId) {
      params.set('subregion_id', glacierFilterSubregionId);
    }
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
  }, [
    glacierViewEnabled,
    glacierFilterBounds,
    glacierFilterAoi,
    glacierFilterSubregionId,
    mapLoaded,
    apiBaseUrl,
    viewState.longitude,
    viewState.latitude,
    viewState.zoom,
  ]);

  const applyIndiaBoundaryLayer = useCallback(() => {
    const map = mapRef.current?.getMap?.();
    if (!map || !map.isStyleLoaded()) return;

    const stateLineColor = theme === 'dark' ? '#8ea2b0' : '#6f7f8a';
    const districtLineColor = theme === 'dark' ? '#667986' : '#9aa7b0';
    const stateLabelColor = theme === 'dark' ? '#d6dee5' : '#40505c';
    const districtLabelColor = theme === 'dark' ? '#c2ccd4' : '#5f6c78';
    const labelHalo = theme === 'dark' ? '#11161b' : '#ffffff';
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
            'line-opacity': 0.58,
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
            'line-opacity': 0.28,
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
    if (!mapLoaded) return undefined;

    const map = mapRef.current?.getMap?.();
    if (!map) return undefined;

    const scaleControl = new maplibregl.ScaleControl({
      maxWidth: 112,
      unit: 'metric',
    });

    map.addControl(scaleControl, 'bottom-left');

    return () => {
      try {
        map.removeControl(scaleControl);
      } catch (error) {
        // MapLibre can remove controls during unmount before React cleanup runs.
      }
    };
  }, [mapLoaded]);

  useEffect(() => {
    if (!focusLocations || focusLocations.length === 0) return;
    const latest = focusLocations[focusLocations.length - 1];
    setViewState((prev) => ({
      ...prev,
      longitude: latest.lon,
      latitude: latest.lat,
      transitionDuration: 600,
    }));
  }, [focusLocations]);

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
      return paletteStops.scientific_diverging;
    }
    return getPaletteStops(layerStyle, 'cividis', variableLabel);
  }, [analysisMode, layerStyle, variableLabel]);

  // Detect whether point data lies on a regular grid so we can render cells
  // instead of scattered dots. Memoised separately so grid detection only
  // runs when `data` changes.
  const gridResolution = useMemo(() => {
    const pts = (data || []).filter((d) => !isGeoJsonFeature(d));
    // Skip detection for discharge-network data (it has its own rendering)
    if (pts.length < 16 || pts.some((d) => d?.kind === 'discharge_network')) return null;
    return inferRegularGridResolution(pts);
  }, [data]);

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
    const safeStops = legendPalette && legendPalette.length >= 2 ? legendPalette : paletteStops.cividis;
    const step = 100 / (safeStops.length - 1);
    return `linear-gradient(90deg, ${safeStops
      .map(([r, g, b], index) => `rgb(${r}, ${g}, ${b}) ${Math.round(index * step)}%`)
      .join(', ')})`;
  }, [legendPalette]);

  const aoiFeatureCollection = useMemo(() => ({
    type: 'FeatureCollection',
    features: (aoiPolygons || [])
      .filter((polygon) => polygon?.geometry)
      .map((polygon, index) => {
        const role = polygon.role || (index === 0 ? 'roi' : 'polygon');
        return {
          type: 'Feature',
          properties: {
            id: polygon.id,
            label: polygon.name || (role === 'roi' ? 'ROI' : 'Polygon'),
            kind: 'custom_aoi',
            role,
            selected: polygon.id === selectedAoiId,
            area_km2: polygon.analysis?.areaKm2,
            vertex_count: polygon.analysis?.vertexCount,
          },
          geometry: polygon.geometry,
        };
      }),
  }), [aoiPolygons, selectedAoiId]);

  const draftAoiFeatureCollection = useMemo(() => {
    const features = [];
    if (draftAoiPoints.length >= 2) {
      features.push({
        type: 'Feature',
        properties: { kind: 'draft_aoi_line' },
        geometry: {
          type: 'LineString',
          coordinates: draftAoiPoints,
        },
      });
    }
    draftAoiPoints.forEach((coordinate, index) => {
      features.push({
        type: 'Feature',
        properties: {
          kind: 'draft_aoi_vertex',
          index,
        },
        geometry: {
          type: 'Point',
          coordinates: coordinate,
        },
      });
    });
    return {
      type: 'FeatureCollection',
      features,
    };
  }, [draftAoiPoints]);

  const layers = useMemo(() => {
    const result = [];
    const featureData = (data || []).filter(isGeoJsonFeature);
    const pointData = (data || []).filter((item) => !isGeoJsonFeature(item));

    // ── Glacier layer (below data) ──────────────────────────────────────
    if (glacierViewEnabled && glacierGeoJson) {
      result.push(
        new GeoJsonLayer({
          id: 'glacier-overview-layer',
          data: glacierGeoJson,
          stroked: true,
          filled: true,
          pickable: true,
          autoHighlight: false,
          getFillColor: theme === 'dark' ? [186, 219, 229, 42] : [134, 189, 205, 46],
          getLineColor: theme === 'dark' ? [229, 241, 245, 178] : [44, 112, 135, 190],
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 0.7,
          lineWidthMaxPixels: 1.7,
          getLineWidth: 1.0,
          parameters: { depthTest: false },
        })
      );
    }

    // ── Draft AOI (below data, drawing helper) ──────────────────────────
    if (draftAoiFeatureCollection.features.length > 0) {
      result.push(
        new GeoJsonLayer({
          id: 'draft-aoi-polygon',
          data: draftAoiFeatureCollection,
          stroked: true,
          filled: true,
          pickable: false,
          pointType: 'circle',
          getFillColor: (feature) => (
            feature.geometry?.type === 'Point' ? [255, 179, 64, 240] : [255, 179, 64, 28]
          ),
          getLineColor: [255, 179, 64, 240],
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 2,
          getLineWidth: 2,
          getPointRadius: 5,
          pointRadiusUnits: 'pixels',
          parameters: { depthTest: false },
        })
      );
    }

    // ── Data layers ─────────────────────────────────────────────────────
    if (data && data.length > 0) {
      // GeoJSON feature data (pre-built polygon cells from backend)
      if (featureData.length > 0) {
        result.push(
          new GeoJsonLayer({
            id: 'geoparquet-network-cells',
            data: {
              type: 'FeatureCollection',
              features: featureData,
            },
            pickable: true,
            stroked: false,
            filled: true,
            opacity: 0.92,
            getFillColor: (feature) => getColorForValue(getDatumValue(feature), valueRange.min, valueRange.max, layerStyle, variableLabel),
            updateTriggers: {
              getFillColor: [valueRange.min, valueRange.max, layerStyle, variableLabel],
            },
            parameters: { depthTest: false },
          })
        );
      }

      // Point data — render as grid cells (GeoJsonLayer with constructed
      // polygons) when a regular grid is detected, otherwise scatter.
      if (pointData.length > 0) {
        if (gridResolution) {
          // ── Grid-cell mode: raster-like filled rectangles ─────────
          const halfLon = gridResolution.longitudeStep / 2;
          const halfLat = gridResolution.latitudeStep / 2;

          const gridCellFeatures = pointData.map((d) => ({
            type: 'Feature',
            properties: { ...d, _grid: true },
            geometry: {
              type: 'Polygon',
              coordinates: [[
                [d.lon - halfLon, d.lat - halfLat],
                [d.lon + halfLon, d.lat - halfLat],
                [d.lon + halfLon, d.lat + halfLat],
                [d.lon - halfLon, d.lat + halfLat],
                [d.lon - halfLon, d.lat - halfLat],
              ]],
            },
          }));

          result.push(
            new GeoJsonLayer({
              id: 'variable-grid-cells',
              data: { type: 'FeatureCollection', features: gridCellFeatures },
              pickable: true,
              stroked: false,
              filled: true,
              getFillColor: (feature) => {
                const d = feature.properties || feature;
                return analysisMode === 'hotspot'
                  ? getColorForTrend(d.slope_per_year, trendRange.maxAbs)
                  : getColorForValue(getDatumValue(feature), valueRange.min, valueRange.max, layerStyle, variableLabel);
              },
              updateTriggers: {
                getFillColor: [analysisMode, valueRange.min, valueRange.max, trendRange.maxAbs, layerStyle, variableLabel],
              },
              parameters: { depthTest: false },
            })
          );
        } else {
          // ── Scatter mode: individual circles for non-gridded data ──
          result.push(
            new ScatterplotLayer({
              id: 'variable-scatter',
              data: pointData,
              pickable: true,
              opacity: analysisMode === 'hotspot' ? 0.86 : 0.78,
              stroked: false,
              filled: true,
              radiusScale: 1,
              radiusMinPixels: analysisMode === 'hotspot' ? 3 : 2,
              radiusMaxPixels: analysisMode === 'hotspot' ? 10 : 9,
              getPosition: (d) => [d.lon, d.lat],
              getRadius: (d) => {
                if (d?.kind === 'discharge_network') return 520;
                if (d?.kind === 'dem') return 1800;
                if (analysisMode !== 'hotspot') return 300;
                const strength = Number.isFinite(d?.trend_strength) ? d.trend_strength : 0;
                const maxAbs = trendRange.maxAbs || 1;
                const normalized = Math.min(1, Math.max(0, strength / maxAbs));
                return 260 + normalized * 620;
              },
              getFillColor: (d) => (
                analysisMode === 'hotspot'
                  ? getColorForTrend(d.slope_per_year, trendRange.maxAbs)
                  : getColorForValue(getDatumValue(d), valueRange.min, valueRange.max, layerStyle, variableLabel)
              ),
              updateTriggers: {
                getFillColor: [analysisMode, valueRange.min, valueRange.max, trendRange.maxAbs, layerStyle, variableLabel],
                getRadius: [analysisMode, trendRange.maxAbs],
              },
              parameters: { depthTest: false },
            })
          );
        }
      }
    }

    // ── Boundary outlines ON TOP of data so they remain visible ─────────
    if (!glacierViewEnabled && basinGeoJson) {
      result.push(
        new GeoJsonLayer({
          id: 'upper-indus-basin-boundary',
          data: basinGeoJson,
          stroked: true,
          filled: false,
          pickable: false,
          getLineColor: theme === 'dark' ? [150, 203, 195, 180] : [0, 84, 120, 185],
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 1,
          lineWidthMaxPixels: 2,
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
          filled: false,
          pickable: false,
          getLineColor: theme === 'dark' ? [255, 190, 190, 235] : [170, 35, 52, 230],
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 1.5,
          lineWidthMaxPixels: 4,
          getLineWidth: 2.1,
          parameters: { depthTest: false },
        })
      );
    }

    if (aoiFeatureCollection.features.length > 0) {
      result.push(
        new GeoJsonLayer({
          id: 'custom-aoi-polygons',
          data: aoiFeatureCollection,
          stroked: true,
          filled: false,
          pickable: !polygonDrawEnabled,
          autoHighlight: true,
          getLineColor: (feature) => (
            feature.properties?.selected
              ? [255, 179, 64, 245]
              : (theme === 'dark' ? [111, 220, 198, 210] : [0, 110, 104, 210])
          ),
          lineWidthUnits: 'pixels',
          lineWidthMinPixels: 1.4,
          lineWidthMaxPixels: 4,
          getLineWidth: (feature) => (feature.properties?.selected ? 2.6 : 1.7),
          updateTriggers: {
            getLineColor: [theme, selectedAoiId],
            getLineWidth: [selectedAoiId],
          },
          parameters: { depthTest: false },
        })
      );
    }

    return result;
  }, [
    data,
    valueRange,
    gridResolution,
    basinGeoJson,
    glacierGeoJson,
    glacierViewEnabled,
    selectedSubregionFeature,
    aoiFeatureCollection,
    draftAoiFeatureCollection,
    polygonDrawEnabled,
    selectedAoiId,
    theme,
    analysisMode,
    trendRange,
    layerStyle,
    variableLabel,
  ]);

  const deckController = useMemo(() => {
    if (polygonDrawEnabled) return false;
    return {
      maxZoom: indiaPmMaxZoom,
    };
  }, [polygonDrawEnabled]);

  const getTooltip = useCallback(({ object }) => {
    if (!object) return null;

    // Grid-cell features from GeoJsonLayer carry datum fields in properties.
    // Unwrap so all downstream tooltip paths see flat datum properties.
    if (object?.properties?._grid) {
      object = object.properties;
    }

    if (object?.properties?.kind === 'custom_aoi') {
      const props = object.properties || {};
      const area = Number(props.area_km2);
      return {
        html: `
          <div style="background: var(--tooltip-bg); padding: 12px; border-radius: 8px; color: var(--text); border: 1px solid var(--tooltip-border);">
            <div style="margin-bottom: 8px; font-weight: bold; border-bottom: 1px solid var(--map-overlay-border); padding-bottom: 4px;">
              ${props.role === 'roi' ? 'ROI Polygon' : 'Polygon'}
            </div>
            <div style="display: grid; grid-template-columns: auto 1fr; gap: 8px; font-size: 13px;">
              <span style="color: var(--text-muted);">Name:</span>
              <span>${props.label || 'Polygon'}</span>
              <span style="color: var(--text-muted);">Area:</span>
              <span>${Number.isFinite(area) ? area.toFixed(2) : 'N/A'} km²</span>
              <span style="color: var(--text-muted);">Vertices:</span>
              <span>${Number(props.vertex_count || 0).toLocaleString()}</span>
            </div>
          </div>
        `,
        style: {
          backgroundColor: 'transparent',
          fontSize: '14px',
        },
      };
    }

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

    if (object?.kind === 'dem') {
      const elevation = getDatumValue(object);
      return {
        html: `
          <div style="background: var(--tooltip-bg); padding: 12px; border-radius: 8px; color: var(--text); border: 1px solid var(--tooltip-border);">
            <div style="margin-bottom: 8px; font-weight: bold; border-bottom: 1px solid var(--map-overlay-border); padding-bottom: 4px;">
              SRTM Terrain
            </div>
            <div style="display: grid; grid-template-columns: auto 1fr; gap: 8px; font-size: 13px;">
              <span style="color: var(--text-muted);">Elevation:</span>
              <span style="font-weight: bold;">${Number.isFinite(elevation) ? elevation.toFixed(0) : 'N/A'} m</span>
              <span style="color: var(--text-muted);">Coordinates:</span>
              <span>${Number(object.lat).toFixed(4)}N, ${Number(object.lon).toFixed(4)}E</span>
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
  }, [analysisMode, currentDate, variableLabel]);

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

  const finishDraftAoi = useCallback((points) => {
    if (!points || points.length < 3) return;
    const ring = [...points, points[0]];
    onAoiComplete?.({
      type: 'Polygon',
      coordinates: [ring],
    });
    setDraftAoiPoints([]);
  }, [onAoiComplete]);

  const handleDeckClick = useCallback((info) => {
    if (polygonDrawEnabled) {
      const coordinate = info?.coordinate;
      if (!coordinate || coordinate.length < 2) return true;
      const lon = Number(coordinate[0]);
      const lat = Number(coordinate[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return true;

      if (draftAoiPoints.length >= 3) {
        const viewport = getViewport();
        const firstPixel = viewport?.project?.(draftAoiPoints[0]);
        const clickedPixel = viewport?.project?.([lon, lat]);
        if (firstPixel && clickedPixel) {
          const distance = Math.hypot(firstPixel[0] - clickedPixel[0], firstPixel[1] - clickedPixel[1]);
          if (distance <= 14) {
            finishDraftAoi(draftAoiPoints);
            return true;
          }
        }
      }
      if (draftAoiPoints.length >= 500) {
        finishDraftAoi(draftAoiPoints);
        return true;
      }
      setDraftAoiPoints((current) => [...current, [lon, lat]]);
      return true;
    }

    const object = info?.object;
    if (object?.properties?.kind === 'custom_aoi') {
      onAoiSelect?.(object.properties.id || '');
      return true;
    }
    return false;
  }, [draftAoiPoints, finishDraftAoi, onAoiSelect, polygonDrawEnabled]);

  const handleDeckDoubleClick = useCallback(() => {
    if (!polygonDrawEnabled || draftAoiPoints.length < 3) return false;
    finishDraftAoi(draftAoiPoints);
    return true;
  }, [draftAoiPoints, finishDraftAoi, polygonDrawEnabled]);

  const prepareSnapshotCapture = useCallback(async (requestedScale = 1, backgroundColor = '#ffffff') => {
    const map = mapRef.current?.getMap?.();
    const deck = deckRef.current?.deck;
    if (!map) return undefined;
    const previousPixelRatio = map.getPixelRatio?.() || window.devicePixelRatio || 1;
    const mapBounds = containerRef.current?.getBoundingClientRect?.();
    const maxCanvasDimension = 8192;
    const safePixelRatio = mapBounds?.width && mapBounds?.height
      ? Math.min(8, maxCanvasDimension / mapBounds.width, maxCanvasDimension / mapBounds.height)
      : 4;
    const exportPixelRatio = Math.min(
      Math.max(previousPixelRatio, safePixelRatio),
      Math.max(previousPixelRatio, Number(requestedScale) || 1),
    );
    const backgroundLayers = (map.getStyle?.()?.layers || [])
      .filter((layer) => layer.type === 'background')
      .map((layer) => ({
        id: layer.id,
        color: map.getPaintProperty?.(layer.id, 'background-color'),
      }));
    backgroundLayers.forEach((layer) => {
      map.setPaintProperty?.(layer.id, 'background-color', backgroundColor);
    });
    if (Math.abs(exportPixelRatio - previousPixelRatio) > 0.01) {
      map.setPixelRatio?.(exportPixelRatio);
    }
    map?.triggerRepaint?.();
    deck?.redraw?.(true);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return () => {
      backgroundLayers.forEach((layer) => {
        map.setPaintProperty?.(layer.id, 'background-color', layer.color);
      });
      if (Math.abs(exportPixelRatio - previousPixelRatio) > 0.01) {
        map.setPixelRatio?.(previousPixelRatio);
      }
      map.triggerRepaint?.();
    };
  }, []);

  const focusSnapshotAtlasRegion = useCallback(async (region) => {
    const bounds = region?.bounds;
    const viewport = getViewport();
    if (!bounds || !viewport?.fitBounds) return;
    if (!atlasOriginalViewRef.current) {
      atlasOriginalViewRef.current = { ...viewStateRef.current };
    }
    const fitted = viewport.fitBounds(
      [
        [Number(bounds.min_lon), Number(bounds.min_lat)],
        [Number(bounds.max_lon), Number(bounds.max_lat)],
      ],
      { padding: Math.max(38, Math.min(viewport.width, viewport.height) * 0.1) },
    );
    setViewState((current) => ({
      ...current,
      longitude: fitted.longitude,
      latitude: fitted.latitude,
      zoom: Math.min(indiaPmMaxZoom, fitted.zoom),
      transitionDuration: 0,
    }));
    atlasFeatureRef.current = null;
    try {
      const response = await fetch(`${apiBaseUrl}/subregions/${encodeURIComponent(region.id)}/geometry`);
      if (response.ok) {
        const payload = await response.json();
        atlasFeatureRef.current = payload?.feature || null;
      }
    } catch (atlasError) {
      atlasFeatureRef.current = null;
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }, [apiBaseUrl]);

  const restoreSnapshotAtlasView = useCallback(async () => {
    atlasFeatureRef.current = null;
    if (atlasOriginalViewRef.current) {
      const original = atlasOriginalViewRef.current;
      atlasOriginalViewRef.current = null;
      setViewState({ ...original, transitionDuration: 0 });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
  }, []);

  const renderSnapshotDataOverlay = useCallback((context, selection, scale) => {
    const viewport = getViewport();
    const mapElement = containerRef.current;
    if (!viewport || !mapElement || !data?.length) return;

    const mapBounds = mapElement.getBoundingClientRect();
    const toOutputPoint = (coordinate) => {
      const longitude = Number(coordinate?.[0]);
      const latitude = Number(coordinate?.[1]);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
      const projected = viewport.project([longitude, latitude]);
      return [
        (mapBounds.left + projected[0] - selection.left) * scale,
        (mapBounds.top + projected[1] - selection.top) * scale,
      ];
    };
    const colorForDatum = (datum) => (
      analysisMode === 'hotspot'
        ? getColorForTrend(Number(datum?.slope_per_year ?? datum?.properties?.slope_per_year), trendRange.maxAbs)
        : getColorForValue(getDatumValue(datum), valueRange.min, valueRange.max, layerStyle, variableLabel)
    );
    const applyColor = (color, opacity = 1) => {
      const alpha = Math.min(1, Math.max(0, ((Number(color?.[3]) || 255) / 255) * opacity));
      return `rgba(${color?.[0] || 0}, ${color?.[1] || 0}, ${color?.[2] || 0}, ${alpha})`;
    };
    const drawLine = (coordinates, closePath = false) => {
      let started = false;
      coordinates.forEach((coordinate) => {
        const point = toOutputPoint(coordinate);
        if (!point) return;
        if (!started) {
          context.moveTo(point[0], point[1]);
          started = true;
        } else {
          context.lineTo(point[0], point[1]);
        }
      });
      if (closePath && started) context.closePath();
    };
    const addGeometryPath = (geometry) => {
      if (!geometry) return false;
      if (geometry.type === 'Polygon') {
        geometry.coordinates.forEach((ring) => drawLine(ring, true));
      } else if (geometry.type === 'MultiPolygon') {
        geometry.coordinates.forEach((polygon) => polygon.forEach((ring) => drawLine(ring, true)));
      } else if (geometry.type === 'LineString') {
        drawLine(geometry.coordinates);
      } else if (geometry.type === 'MultiLineString') {
        geometry.coordinates.forEach((line) => drawLine(line));
      } else {
        return false;
      }
      return true;
    };
    const drawBoundaryOverlay = (geoJson, strokeStyle, lineWidth) => {
      if (!geoJson) return;
      const features = geoJson.type === 'FeatureCollection'
        ? geoJson.features || []
        : geoJson.type === 'Feature'
          ? [geoJson]
          : [{ geometry: geoJson }];
      context.beginPath();
      let hasPath = false;
      features.forEach((feature) => {
        hasPath = addGeometryPath(feature?.geometry) || hasPath;
      });
      if (!hasPath) return;
      context.strokeStyle = strokeStyle;
      context.lineWidth = lineWidth;
      context.lineJoin = 'round';
      context.lineCap = 'round';
      context.stroke();
    };
    const pointData = data.filter((datum) => !isGeoJsonFeature(datum));
    const hasPointNetwork = pointData.some((datum) => datum?.kind === 'discharge_network');
    const gridResolution = hasPointNetwork ? null : inferRegularGridResolution(pointData);

    context.save();
    context.beginPath();
    context.rect(0, 0, selection.width * scale, selection.height * scale);
    context.clip();

    data.forEach((datum) => {
      const color = colorForDatum(datum);
      if (!isGeoJsonFeature(datum)) {
        const longitude = Number(datum?.lon);
        const latitude = Number(datum?.lat);
        const opaqueColor = `rgb(${color?.[0] || 0}, ${color?.[1] || 0}, ${color?.[2] || 0})`;
        if (gridResolution && Number.isFinite(longitude) && Number.isFinite(latitude)) {
          const halfLongitude = gridResolution.longitudeStep / 2;
          const halfLatitude = gridResolution.latitudeStep / 2;
          const cell = [
            [longitude - halfLongitude, latitude - halfLatitude],
            [longitude + halfLongitude, latitude - halfLatitude],
            [longitude + halfLongitude, latitude + halfLatitude],
            [longitude - halfLongitude, latitude + halfLatitude],
          ].map(toOutputPoint);
          if (cell.some((point) => !point)) return;
          context.beginPath();
          context.moveTo(cell[0][0], cell[0][1]);
          for (let index = 1; index < cell.length; index += 1) {
            context.lineTo(cell[index][0], cell[index][1]);
          }
          context.closePath();
          context.fillStyle = opaqueColor;
          context.strokeStyle = opaqueColor;
          context.lineWidth = Math.max(0.65, scale * 0.22);
          context.fill();
          context.stroke();
          return;
        }

        // Irregular observations are point samples, not raster cells. A small
        // square preserves their discrete nature without implying a circular
        // spatial footprint.
        const point = toOutputPoint([longitude, latitude]);
        if (!point) return;
        const symbolSize = (analysisMode === 'hotspot' ? 5 : 3.5) * scale;
        context.fillStyle = opaqueColor;
        context.fillRect(
          point[0] - (symbolSize / 2),
          point[1] - (symbolSize / 2),
          symbolSize,
          symbolSize,
        );
        return;
      }

      const geometry = datum.geometry || {};
      context.beginPath();
      if (!addGeometryPath(geometry)) return;
      context.fillStyle = applyColor(color, 0.92);
      context.strokeStyle = theme === 'dark' ? 'rgba(17, 22, 27, 0.45)' : 'rgba(255, 255, 255, 0.55)';
      context.lineWidth = Math.max(0.35, 0.45 * scale);
      if (geometry.type.includes('Polygon')) context.fill('evenodd');
      context.stroke();
    });

    // Cartographic reference outlines belong above the scientific surface.
    if (!glacierViewEnabled) {
      drawBoundaryOverlay(
        basinGeoJson,
        theme === 'dark' ? 'rgba(190, 231, 225, 0.95)' : 'rgba(0, 76, 110, 0.95)',
        Math.max(1.2, scale * 0.75),
      );
    }
    if (glacierViewEnabled) {
      drawBoundaryOverlay(
        glacierGeoJson,
        theme === 'dark' ? 'rgba(235, 247, 250, 0.92)' : 'rgba(30, 96, 120, 0.92)',
        Math.max(0.8, scale * 0.5),
      );
    }
    drawBoundaryOverlay(
      selectedSubregionFeature,
      theme === 'dark' ? 'rgba(255, 205, 205, 0.98)' : 'rgba(155, 20, 42, 0.98)',
      Math.max(1.5, scale * 0.95),
    );
    drawBoundaryOverlay(
      atlasFeatureRef.current,
      theme === 'dark' ? 'rgba(255, 226, 138, 1)' : 'rgba(141, 75, 0, 1)',
      Math.max(1.8, scale * 1.1),
    );
    context.restore();
  }, [
    data,
    analysisMode,
    trendRange.maxAbs,
    valueRange.min,
    valueRange.max,
    layerStyle,
    theme,
    viewState,
    basinGeoJson,
    glacierGeoJson,
    glacierViewEnabled,
    selectedSubregionFeature,
  ]);

  const snapshotMetadata = useMemo(() => ({
    variableLabel: analysisMode === 'hotspot' ? 'Trend slope / year' : variableLabel,
    analysisMode,
    currentDate,
    pointCount: data.length,
    legendRange,
    legendPalette,
    bearing: Number(viewState.bearing) || 0,
    atlasRegions,
    focusAtlasRegion: focusSnapshotAtlasRegion,
    restoreAtlasView: restoreSnapshotAtlasView,
    project: (coordinate) => getViewport()?.project(coordinate),
    unproject: (point) => getViewport()?.unproject(point),
  }), [
    analysisMode,
    variableLabel,
    currentDate,
    data.length,
    legendRange,
    legendPalette,
    viewState,
    atlasRegions,
    focusSnapshotAtlasRegion,
    restoreSnapshotAtlasView,
  ]);

  return (
    <div className="map-view" ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%' }}>
      <DeckGL
        ref={deckRef}
        viewState={viewState}
        onViewStateChange={({ viewState: next }) => setViewState(next)}
        controller={deckController}
        layers={layers}
        getTooltip={getTooltip}
        onClick={handleDeckClick}
        onDblClick={handleDeckDoubleClick}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      >
        <Map
          ref={mapRef}
          mapStyle={mapStyle}
          attributionControl={false}
          maxZoom={indiaPmMaxZoom}
          onLoad={handleMapLoad}
          onStyleData={handleMapStyleData}
        >
          {focusLocations.map((loc) => (
            <Marker
              key={loc.id}
              longitude={loc.lon}
              latitude={loc.lat}
              draggable
              onDragEnd={(e) => onUpdateFocusLocation?.(loc.id, e.lngLat.lat, e.lngLat.lng)}
              onClick={(e) => {
                e.originalEvent.stopPropagation();
                onRemoveFocusLocation?.(loc.id);
              }}
            >
              <div
                style={{
                  cursor: 'pointer',
                  transform: 'translate(0, -24px)',
                }}
                title="Drag to move. Click to remove."
              >
                <img src={FOCUS_PIN_SVG_URL} style={{ width: 48, height: 64, pointerEvents: 'none' }} alt="pin" />
              </div>
            </Marker>
          ))}
        </Map>
      </DeckGL>

      {!selectionOnly && <div className="map-aoi-tools" onMouseDown={(event) => event.stopPropagation()}>
        <button
          type="button"
          className={`map-aoi-button ${polygonDrawEnabled ? 'active' : ''}`}
          onClick={() => onPolygonDrawToggle?.()}
          title={polygonDrawEnabled ? 'Cancel polygon drawing' : 'Draw a polygon'}
          aria-pressed={polygonDrawEnabled}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7.2 4.6 18 7.1l1.7 9.9-8.6 3.1-7.8-6.2 3.9-9.3Zm.9 2.2-2.5 6 5.9 4.7 6-2.1-1.2-6.7-8.2-1.9Z" />
          </svg>
          <span>{polygonDrawEnabled ? 'Cancel' : 'Polygon'}</span>
        </button>
        {polygonDrawEnabled && (
          <div className="map-aoi-instruction">
            {draftAoiPoints.length < 3
              ? `Click ${3 - draftAoiPoints.length} more point${3 - draftAoiPoints.length === 1 ? '' : 's'}`
              : 'Click the first point or double-click to close'}
          </div>
        )}
      </div>}

      {!selectionOnly && <button
        type="button"
        className="map-snapshot-button"
        onClick={() => setSnapshotOpen(true)}
        onMouseDown={(event) => event.stopPropagation()}
        title="Create a publication-ready map snapshot"
        aria-label="Open map snapshot and print layout"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8.2 5.5 9.4 3.8h5.2l1.2 1.7H19a2 2 0 0 1 2 2v10.2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2h3.2Zm3.8 3a4.1 4.1 0 1 0 0 8.2 4.1 4.1 0 0 0 0-8.2Zm0 1.8a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6Z" />
        </svg>
        <span>Snapshot</span>
      </button>}

      {!selectionOnly && <div style={{
        position: 'absolute',
        bottom: '32px',
        right: '12px',
        maxWidth: '220px',
        background: 'var(--map-overlay-bg)',
        padding: '10px 11px',
        borderRadius: '6px',
        color: 'var(--map-overlay-text)',
        fontSize: '11px',
        border: '1px solid var(--map-overlay-border)',
        boxShadow: '0 4px 16px var(--shadow)',
        zIndex: 10,
        pointerEvents: 'auto',
      }}>
        <div style={{ fontWeight: 'bold', marginBottom: '6px', fontSize: '11px', lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {analysisMode === 'hotspot' ? 'Trend (Slope/yr)' : `${variableLabel || 'Value'}`}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div
            style={{
              height: '10px',
              borderRadius: '2px',
              background: legendGradient,
              border: '1px solid var(--map-overlay-border)',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', fontSize: '10px', color: 'var(--map-overlay-muted)' }}>
            <span>{legendRange.min.toFixed(2)}</span>
            <span>{legendRange.mid.toFixed(2)}</span>
            <span>{legendRange.max.toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', fontSize: '10px', color: 'var(--map-overlay-muted)' }}>
            <span>{analysisMode === 'hotspot' ? 'Decrease' : 'Low'}</span>
            <span>{analysisMode === 'hotspot' ? 'Neutral' : 'Mid'}</span>
            <span>{analysisMode === 'hotspot' ? 'Increase' : 'High'}</span>
          </div>
        </div>
        <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid var(--map-overlay-border)', fontSize: '10px', color: 'var(--map-overlay-muted)' }}>
          {data.length.toLocaleString()} {analysisMode === 'hotspot' ? 'trend pts' : 'data pts'}
          {analysisMode === 'hotspot' && hotspotSummary?.hotspots_identified !== undefined && (
            <div style={{ marginTop: '4px' }}>
              Hotspots: {Number(hotspotSummary.hotspots_identified).toLocaleString()}
            </div>
          )}
          {glacierViewEnabled && (
            <div style={{ marginTop: '4px' }}>
              {glacierMeta?.zoom_limited
                ? `Zoom in to ${Number(glacierMeta?.minimum_zoom || MIN_GLACIER_VIEW_ZOOM).toFixed(1)}+`
                : `Glaciers: ${Number(glacierMeta?.count || 0).toLocaleString()}${glacierMeta?.truncated ? '+' : ''}`}
            </div>
          )}
        </div>
      </div>}

      {!selectionOnly && <div style={{
        position: 'absolute',
        top: '12px',
        left: '12px',
        background: 'var(--map-overlay-bg)',
        padding: '6px 10px',
        borderRadius: '5px',
        color: 'var(--map-overlay-text)',
        fontSize: '12px',
        fontWeight: '700',
        border: '1px solid var(--map-overlay-border)',
        boxShadow: '0 4px 16px var(--shadow)',
        zIndex: 11,
        pointerEvents: 'none',
      }}>
        {analysisMode === 'hotspot' ? 'Hotspot Analysis' : `${currentDate}`}
      </div>}

      {!selectionOnly && snapshotOpen && (
        <Suspense fallback={null}>
          <SnapshotLayout
            mapElement={containerRef.current}
            onClose={() => setSnapshotOpen(false)}
            prepareCapture={prepareSnapshotCapture}
            renderDataOverlay={renderSnapshotDataOverlay}
            metadata={snapshotMetadata}
          />
        </Suspense>
      )}
    </div>
  );
}

export default React.memo(MapView);
