import React, { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import TimeSlider from './components/TimeSlider';
import ElevationFilter from './components/ElevationFilter';
import apiService from './services/api';
import shpjs, { parseShp, parseDbf, combine as shpCombine } from 'shpjs';
import { formatDisplayDate } from './utils/dateUtils';
import './App.css';

const MapView = lazy(() => import('./components/MapView'));
const TempGraph = lazy(() => import('./components/TempGraph'));
const DocumentationPage = lazy(() => import('./components/DocumentationPage'));
const DashboardCodePanel = lazy(() => import('./components/DashboardCodePanel'));
const ResearchToolkitPanel = lazy(() => import('./components/ResearchToolkitPanel'));
const ProjectsHome = lazy(() => import('./components/ProjectsHome'));
const ExportDataModal = lazy(() => import('./components/ExportDataModal'));
const DatasetConfigModal = lazy(() => import('./components/DatasetConfigModal'));

const DeferredPanelFallback = () => (
  <div className="deferred-panel-loading" role="status" aria-live="polite">
    <div className="loading-spinner" />
    <p>Loading tools...</p>
  </div>
);

const NavigationControls = React.memo(({
  canGoBack,
  canGoForward,
  onBack,
  onForward,
}) => (
  <nav className="navigation-controls" aria-label="Page history">
    <button
      type="button"
      className="navigation-button"
      onClick={onBack}
      disabled={!canGoBack}
      aria-label="Go back to the previous page"
      title={canGoBack ? 'Go back (Alt + Left Arrow)' : 'No previous page'}
    >
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M8.7 4.3 3 10l5.7 5.7 1.4-1.4L6.8 11H17V9H6.8l3.3-3.3-1.4-1.4Z" />
      </svg>
      <span>Back</span>
    </button>
    <button
      type="button"
      className="navigation-button"
      onClick={onForward}
      disabled={!canGoForward}
      aria-label="Go forward to the next page"
      title={canGoForward ? 'Go forward (Alt + Right Arrow)' : 'No next page'}
    >
      <span>Forward</span>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="m11.3 4.3-1.4 1.4L13.2 9H3v2h10.2l-3.3 3.3 1.4 1.4L17 10l-5.7-5.7Z" />
      </svg>
    </button>
  </nav>
));

const formatVariableLabel = (name) => {
  if (!name) return '';
  if (name === 'elevation_m') return 'DEM Elevation (m)';
  const parts = name.split('_');
  if (parts.length === 1) {
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  const unit = parts[parts.length - 1];
  const label = parts.slice(0, -1).join(' ');
  const prettyLabel = label.replace(/\b\w/g, (c) => c.toUpperCase());
  return `${prettyLabel} (${unit})`;
};

const normalizeYearRange = (yearRange) => {
  const start = Number(yearRange?.start);
  const end = Number(yearRange?.end);
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  return { start: Math.min(start, end), end: Math.max(start, end) };
};

const buildAnalysisItemId = (datasetId, yearRange, variable) => {
  const normalizedRange = normalizeYearRange(yearRange);
  return [
    datasetId || '',
    normalizedRange?.start ?? '',
    normalizedRange?.end ?? '',
    variable || '',
  ].join('::');
};

const createAnalysisItem = ({ datasetId, datasetLabel, yearRange, variable, selectedAt }) => {
  const normalizedRange = normalizeYearRange(yearRange);
  if (!datasetId || !normalizedRange || !variable) return null;
  return {
    id: buildAnalysisItemId(datasetId, normalizedRange, variable),
    datasetId,
    datasetLabel: datasetLabel || datasetId,
    yearRange: normalizedRange,
    variable,
    variableLabel: formatVariableLabel(variable),
    selectedAt: Number.isFinite(Number(selectedAt)) ? Number(selectedAt) : Date.now(),
  };
};

const normalizeAnalysisItems = (items = [], legacyDashboard = {}) => {
  const normalized = [];
  const seen = new Set();
  const pushItem = (item) => {
    const normalizedItem = createAnalysisItem(item);
    if (!normalizedItem || seen.has(normalizedItem.id)) return;
    seen.add(normalizedItem.id);
    normalized.push(normalizedItem);
  };

  if (Array.isArray(items)) {
    items.forEach((item) => {
      pushItem({
        datasetId: item?.datasetId,
        datasetLabel: item?.datasetLabel,
        yearRange: item?.yearRange,
        variable: item?.variable,
        selectedAt: item?.selectedAt,
      });
    });
  }

  if (normalized.length > 0) return normalized;

  const legacyDatasetId = legacyDashboard.datasetId;
  const legacyYearRange = legacyDashboard.selectedYearRange;
  const legacyVariables = Array.from(new Set([
    legacyDashboard.selectedVariable,
    ...(Array.isArray(legacyDashboard.comparisonVariables) ? legacyDashboard.comparisonVariables : []),
  ])).filter(Boolean);

  legacyVariables.forEach((variable, index) => {
    pushItem({
      datasetId: legacyDatasetId,
      datasetLabel: legacyDashboard.datasetLabel,
      yearRange: legacyYearRange,
      variable,
      selectedAt: Date.now() - index,
    });
  });

  return normalized;
};

const sameYearRange = (left, right) => {
  const normalizedLeft = normalizeYearRange(left);
  const normalizedRight = normalizeYearRange(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft.start === normalizedRight.start && normalizedLeft.end === normalizedRight.end;
};

const getAnalysisGraphRequestKey = (item, elevRange, subregionId, aoiKey = '') => [
  item?.datasetId || '',
  item?.yearRange?.start ?? '',
  item?.yearRange?.end ?? '',
  item?.variable || '',
  elevRange?.min ?? '',
  elevRange?.max ?? '',
  subregionId || '',
  aoiKey,
].join('|');

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const compactTextFingerprint = (value) => String(value || '').slice(0, 240);

const compactResultFingerprint = (result) => {
  if (!result || typeof result !== 'object') return null;
  const outputs = Array.isArray(result.outputs) ? result.outputs : [];
  const layers = Array.isArray(result.layers) ? result.layers : [];
  return {
    ok: result.ok,
    status: result.status,
    job_id: result.job_id,
    run_id: result.run_id,
    duration_ms: result.duration_ms,
    stdout: compactTextFingerprint(result.stdout),
    stderr: compactTextFingerprint(result.stderr),
    error: compactTextFingerprint(result.error),
    row_count: result.meta?.row_count ?? result.coverage?.pixel_count,
    outputs: outputs.map((output) => ({
      type: output.type,
      name: output.name,
      row_count: output.row_count,
      filename: output.filename,
      value: ['number', 'result', 'text'].includes(output.type) ? compactTextFingerprint(output.value) : undefined,
      feature_count: Array.isArray(output.features) ? output.features.length : undefined,
    })),
    layers: layers.map((layer) => ({
      id: layer.id,
      label: layer.label,
      count: Array.isArray(layer.data) ? layer.data.length : undefined,
    })),
  };
};

const compactToolsFingerprint = (tools = {}) => ({
  code: {
    workspaceVersion: tools.code?.workspaceVersion,
    activeFileId: tools.code?.activeFileId,
    files: Array.isArray(tools.code?.files)
      ? tools.code.files.map((file) => ({
        id: file.id,
        name: file.name,
        content: file.content || '',
        activeTab: file.activeTab,
        activeMapOutputIndex: file.activeMapOutputIndex,
        validationOk: file.validation?.ok,
        result: compactResultFingerprint(file.result),
      }))
      : undefined,
    panelMode: tools.code?.panelMode,
    chatCount: tools.code?.chatMessages?.length || 0,
    dateMode: tools.code?.dateMode,
    rangeStartDate: tools.code?.rangeStartDate,
    rangeEndDate: tools.code?.rangeEndDate,
    timeoutSeconds: tools.code?.timeoutSeconds,
    activeTab: tools.code?.activeTab,
    activeMapOutputIndex: tools.code?.activeMapOutputIndex,
    validationOk: tools.code?.validation?.ok,
    result: compactResultFingerprint(tools.code?.result),
  },
  research: {
    specs: tools.research?.specs,
    methods: tools.research?.methods,
    period: tools.research?.period,
    advancedOpen: tools.research?.advancedOpen,
    settings: tools.research?.settings,
    outputTab: tools.research?.outputTab,
    activeLayer: tools.research?.activeLayer,
    figureCount: tools.research?.figures?.length || 0,
    result: compactResultFingerprint(tools.research?.result),
  },
});

const getCodeStateForProjectStorage = (codeState = {}) => {
  if (Array.isArray(codeState.files) && codeState.files.length > 0) {
    const { code: _code, result: _result, validation: _validation, ...rest } = codeState;
    return rest;
  }
  return { ...codeState, code: undefined };
};

const buildProjectFingerprint = (workspace, code) => JSON.stringify({
  schemaVersion: workspace?.schemaVersion,
  view: workspace?.view,
  dashboard: workspace?.dashboard,
  layout: workspace?.layout,
  tools: compactToolsFingerprint(workspace?.tools),
  code: code || '',
});

const getGeoJsonBounds = (feature) => {
  const coordinates = feature?.geometry?.coordinates;
  if (!Array.isArray(coordinates)) return null;
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  const visit = (value) => {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1]))) {
      const lon = Number(value[0]);
      const lat = Number(value[1]);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      return;
    }
    value.forEach(visit);
  };

  visit(coordinates);
  return [minLat, maxLat, minLon, maxLon].every(Number.isFinite)
    ? { minLat, maxLat, minLon, maxLon }
    : null;
};

const expandBoundsByKm = (bounds, bufferKm = 0) => {
  if (!bounds || bufferKm <= 0) return bounds || null;
  const midLat = Math.max(-89, Math.min(89, (Number(bounds.minLat) + Number(bounds.maxLat)) / 2));
  const latDelta = bufferKm / 111.32;
  const lonScale = Math.max(0.2, Math.abs(Math.cos((midLat * Math.PI) / 180)));
  const lonDelta = bufferKm / (111.32 * lonScale);
  return {
    minLat: Math.max(-90, Number(bounds.minLat) - latDelta),
    maxLat: Math.min(90, Number(bounds.maxLat) + latDelta),
    minLon: Math.max(-180, Number(bounds.minLon) - lonDelta),
    maxLon: Math.min(180, Number(bounds.maxLon) + lonDelta),
  };
};

const getSubregionBounds = (item) => {
  const bounds = item?.bounds;
  if (!bounds) return null;
  const mapped = {
    minLat: Number(bounds.min_lat ?? bounds.minLat),
    maxLat: Number(bounds.max_lat ?? bounds.maxLat),
    minLon: Number(bounds.min_lon ?? bounds.minLon),
    maxLon: Number(bounds.max_lon ?? bounds.maxLon),
  };
  return Object.values(mapped).every(Number.isFinite) ? mapped : null;
};

const boundsIntersect = (a, b) => Boolean(
  a
  && b
  && a.minLat <= b.maxLat
  && a.maxLat >= b.minLat
  && a.minLon <= b.maxLon
  && a.maxLon >= b.minLon
);

const parseCoordinates = (text) => {
  const cleanText = text.trim();
  let match = cleanText.match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
  if (match) {
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      return { lat, lon };
    }
  }
  const dmsRegex = /^(\d+)[°\s]+(\d+)['\s]+([\d.]+)[″"\s]*([NS])\s*,\s*(\d+)[°\s]+(\d+)['\s]+([\d.]+)[″"\s]*([EW])$/i;
  match = cleanText.match(dmsRegex);
  if (match) {
    const lat = parseInt(match[1], 10) + parseInt(match[2], 10) / 60 + parseFloat(match[3]) / 3600;
    const lon = parseInt(match[5], 10) + parseInt(match[6], 10) / 60 + parseFloat(match[7]) / 3600;
    const finalLat = match[4].toUpperCase() === 'S' ? -lat : lat;
    const finalLon = match[8].toUpperCase() === 'W' ? -lon : lon;
    if (finalLat >= -90 && finalLat <= 90 && finalLon >= -180 && finalLon <= 180) {
      return { lat: finalLat, lon: finalLon };
    }
  }
  return null;
};

const MAX_POLYGON_VERTICES = 500;
const GLACIER_LAYER_VARIABLE = '__glacier_outlines__';
const GRAPH_FETCH_CONCURRENCY = 2;

const normalizeAoiPolygon = (polygon, index = 0) => {
  const coordinates = polygon?.geometry?.coordinates?.[0];
  if (!Array.isArray(coordinates) || coordinates.length < 4) return null;
  const vertices = coordinates
    .slice(0, -1)
    .map((coord) => [Number(coord?.[0]), Number(coord?.[1])])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (vertices.length < 3 || vertices.length > MAX_POLYGON_VERTICES) return null;
  const closedRing = [...vertices, vertices[0]];
  const normalized = {
    id: String(polygon.id || `aoi-${Date.now()}-${index}`),
    name: String(polygon.name || polygon.label || (index === 0 ? 'ROI' : `Polygon ${index + 1}`)),
    role: index === 0 ? 'roi' : 'polygon',
    createdAt: Number.isFinite(Number(polygon.createdAt)) ? Number(polygon.createdAt) : Date.now(),
    metadata: polygon.metadata && typeof polygon.metadata === 'object' ? polygon.metadata : {},
    geometry: {
      type: 'Polygon',
      coordinates: [closedRing],
    },
  };
  return {
    ...normalized,
    analysis: analyzeAoiGeometry(normalized),
  };
};

const normalizeAoiPolygons = (polygons = []) => (
  Array.isArray(polygons)
    ? polygons.map(normalizeAoiPolygon).filter(Boolean).map((polygon, index) => ({
      ...polygon,
      role: index === 0 ? 'roi' : 'polygon',
      name: index === 0 && polygon.role !== 'roi' ? 'ROI' : (polygon.name || `Polygon ${index + 1}`),
    }))
    : []
);

const getAoiVertices = (aoi) => (
  Array.isArray(aoi?.geometry?.coordinates?.[0])
    ? aoi.geometry.coordinates[0].slice(0, -1)
    : []
);

const analyzeAoiGeometry = (aoi) => {
  const vertices = getAoiVertices(aoi);
  if (vertices.length < 3) {
    return {
      vertexCount: 0,
      areaKm2: 0,
      perimeterKm: 0,
      centroid: null,
      bounds: null,
      geometryType: aoi?.geometry?.type || 'Polygon',
    };
  }

  const earthRadiusKm = 6371.0088;
  const lons = vertices.map(([lon]) => Number(lon));
  const lats = vertices.map(([, lat]) => Number(lat));
  const centroid = {
    lon: lons.reduce((sum, value) => sum + value, 0) / lons.length,
    lat: lats.reduce((sum, value) => sum + value, 0) / lats.length,
  };
  const latScale = Math.PI * earthRadiusKm / 180;
  const lonScale = latScale * Math.cos((centroid.lat * Math.PI) / 180);
  const projected = vertices.map(([lon, lat]) => ({
    x: (Number(lon) - centroid.lon) * lonScale,
    y: (Number(lat) - centroid.lat) * latScale,
  }));
  let shoelace = 0;
  let perimeterKm = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const current = projected[index];
    const next = projected[(index + 1) % projected.length];
    shoelace += current.x * next.y - next.x * current.y;
    perimeterKm += Math.hypot(next.x - current.x, next.y - current.y);
  }

  const lowerName = String(aoi?.name || '').toLowerCase();
  const focus = lowerName.includes('glacier')
    ? 'Glacier'
    : lowerName.includes('watershed') || lowerName.includes('catchment')
      ? 'Watershed'
      : lowerName.includes('lake') || lowerName.includes('reservoir')
        ? 'Lake/reservoir'
        : 'Custom study area';

  return {
    vertexCount: vertices.length,
    areaKm2: Math.abs(shoelace) / 2,
    perimeterKm,
    centroid,
    bounds: {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    },
    geometryType: aoi?.geometry?.type || 'Polygon',
    focus,
    characteristics: {
      glacier: focus === 'Glacier' ? { area_km2: Math.abs(shoelace) / 2, retreat_ready: true } : null,
      watershed: focus === 'Watershed' ? { catchment_area_km2: Math.abs(shoelace) / 2 } : null,
      lake: focus === 'Lake/reservoir' ? { surface_area_km2: Math.abs(shoelace) / 2 } : null,
    },
  };
};

// ── IndexedDB helpers for shapefile polygon persistence ───────────────
const SHAPE_DB_NAME = 'hba_shapefiles';
const SHAPE_DB_VERSION = 1;
const SHAPE_STORE_NAME = 'polygons';

const shapefileDB = {
  _open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(SHAPE_DB_NAME, SHAPE_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SHAPE_STORE_NAME)) {
          db.createObjectStore(SHAPE_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },
  async savePolygons(polygons) {
    try {
      const db = await this._open();
      const tx = db.transaction(SHAPE_STORE_NAME, 'readwrite');
      const store = tx.objectStore(SHAPE_STORE_NAME);
      store.clear();
      polygons.forEach((p) => store.put(p));
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (err) {
      console.warn('Shapefile DB save failed:', err);
    }
  },
  async loadPolygons() {
    try {
      const db = await this._open();
      const tx = db.transaction(SHAPE_STORE_NAME, 'readonly');
      const store = tx.objectStore(SHAPE_STORE_NAME);
      const all = await new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      db.close();
      return all || [];
    } catch (err) {
      console.warn('Shapefile DB load failed:', err);
      return [];
    }
  },
};

const extractPolygonFeatures = (geojson) => {
  const features = geojson?.type === 'FeatureCollection'
    ? (geojson.features || [])
    : geojson?.type === 'Feature'
      ? [geojson]
      : geojson?.type === 'Polygon' || geojson?.type === 'MultiPolygon'
        ? [{ type: 'Feature', properties: {}, geometry: geojson }]
        : [];
  const result = [];
  features.forEach((feature) => {
    const geom = feature?.geometry;
    if (!geom) return;
    if (geom.type === 'Polygon') {
      result.push(feature);
    } else if (geom.type === 'MultiPolygon') {
      // Split MultiPolygon into individual Polygon features
      (geom.coordinates || []).forEach((coords, idx) => {
        result.push({
          type: 'Feature',
          properties: { ...feature.properties, _partIndex: idx },
          geometry: { type: 'Polygon', coordinates: coords },
        });
      });
    }
  });
  return result;
};

function App() {
  // State management
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem('theme');
    return stored === 'light' || stored === 'dark' ? stored : 'light';
  });
  const [datasets, setDatasets] = useState([]);
  const [outcomes, setOutcomes] = useState([]);
  const [selectedOutcomeId, setSelectedOutcomeId] = useState('long_term_hotspot');
  const [datasetId, setDatasetId] = useState('');
  const [homeModule, setHomeModule] = useState('projects');
  const [datasetReady, setDatasetReady] = useState(false);
  const [datasetLoading, setDatasetLoading] = useState(true);
  const [showDocumentation, setShowDocumentation] = useState(false);
  const [codePanelOpen, setCodePanelOpen] = useState(false);
  const [codeMapOutput, setCodeMapOutput] = useState(null);
  const [researchPanelOpen, setResearchPanelOpen] = useState(false);
  const [researchMapOutput, setResearchMapOutput] = useState(null);
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState('');
  const [activeProject, setActiveProject] = useState(null);
  const [projectDirty, setProjectDirty] = useState(false);
  const [projectSaveState, setProjectSaveState] = useState('idle');
  const [projectToolState, setProjectToolState] = useState({ code: {}, research: {} });
  const projectBaselineRef = useRef('');
  const latestProjectFingerprintRef = useRef('');
  const projectRestoreTimerRef = useRef(null);
  const pendingProjectRestoreRef = useRef(null);
  const projectRestoreSnapshotRef = useRef(null);
  const codeWorkspaceLiveRef = useRef(null);
  const [yearOptions, setYearOptions] = useState([]);
  const [yearRangeLoading, setYearRangeLoading] = useState(false);
  const [yearRangeError, setYearRangeError] = useState('');
  const [selectedYearRange, setSelectedYearRange] = useState({ start: null, end: null });
  const [ncFile, setNcFile] = useState(null);
  const [ncDatasetName, setNcDatasetName] = useState('');
  const [ncUploading, setNcUploading] = useState(false);
  const [ncUploadError, setNcUploadError] = useState('');
  const [ncUploadMessage, setNcUploadMessage] = useState('');
  const [showNcHelp, setShowNcHelp] = useState(false);
  const [dates, setDates] = useState([]);
  const [currentDateIndex, setCurrentDateIndex] = useState(0);
  const [currentDate, setCurrentDate] = useState(null);
  const [variables, setVariables] = useState([]);
  const [selectedVariable, setSelectedVariable] = useState('');
  const [comparisonVariables, setComparisonVariables] = useState([]);
  const [selectedAnalysisItems, setSelectedAnalysisItems] = useState([]);
  const [analysisGraphEntries, setAnalysisGraphEntries] = useState({});
  const [analysisGraphHeights, setAnalysisGraphHeights] = useState(() => {
    try {
      const stored = JSON.parse(localStorage.getItem('analysisGraphHeights') || '{}');
      return stored && typeof stored === 'object' ? stored : {};
    } catch {
      return {};
    }
  });
  const [variablesContextKey, setVariablesContextKey] = useState('');
  const [searchToolsOpen, setSearchToolsOpen] = useState(false);
  const [activeToolPanel, setActiveToolPanel] = useState('');
  const [polygonDrawMode, setPolygonDrawMode] = useState(false);
  const [aoiPolygons, setAoiPolygons] = useState([]);
  const [selectedAoiId, setSelectedAoiId] = useState('');
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [datasetConfigModalOpen, setDatasetConfigModalOpen] = useState(false);
  const [datasetConfig, setDatasetConfig] = useState(null);
  const [shapefileLoading, setShapefileLoading] = useState(false);
  const shapefileRestoredRef = useRef(false);
  const [subregions, setSubregions] = useState([]);
  const [subregionsLoading, setSubregionsLoading] = useState(false);
  const [selectedSubregionId, setSelectedSubregionId] = useState('');
  const [selectedSubregionFeature, setSelectedSubregionFeature] = useState(null);
  const [subregionSearchText, setSubregionSearchText] = useState('');
  const [subregionDropdownOpen, setSubregionDropdownOpen] = useState(false);
  const [focusLocations, setFocusLocations] = useState([]);
  const [elevationRange, setElevationRange] = useState({ min: 500, max: 9000 });
  const [selectedElevRange, setSelectedElevRange] = useState({ min: 500, max: 9000 });
  const [mapData, setMapData] = useState([]);
  const [mapViewMode, setMapViewMode] = useState('basin');
  const [analysisMode, setAnalysisMode] = useState('daily');
  const [hotspotData, setHotspotData] = useState([]);
  const [hotspotSummary, setHotspotSummary] = useState(null);
  const [hotspotLoading, setHotspotLoading] = useState(false);
  const [hotspotError, setHotspotError] = useState('');
  const [hotspotMinYears, setHotspotMinYears] = useState(3);
  const [outcomeMetaLoading, setOutcomeMetaLoading] = useState(false);
  const [outcomeMetaError, setOutcomeMetaError] = useState('');
  const [outcomeMeta, setOutcomeMeta] = useState(null);
  const [outcomeVariable, setOutcomeVariable] = useState('');
  const [outcomeBandId, setOutcomeBandId] = useState('');
  const [outcomeViewMode, setOutcomeViewMode] = useState('mean');
  const [outcomeComparisonId, setOutcomeComparisonId] = useState('');
  const [outcomeData, setOutcomeData] = useState([]);
  const [outcomeStats, setOutcomeStats] = useState(null);
  const [outcomeDataLoading, setOutcomeDataLoading] = useState(false);
  const [outcomeDataError, setOutcomeDataError] = useState('');
  const [loading, setLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(500); // ms per frame
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(() => {
    const stored = Number(localStorage.getItem('bottomPanelHeight'));
    return Number.isFinite(stored) ? clamp(stored, 180, 520) : 360;
  });
  const [codePanelWidth, setCodePanelWidth] = useState(() => {
    const stored = Number(localStorage.getItem('codePanelWidth'));
    return Number.isFinite(stored) ? clamp(stored, 360, 760) : 620;
  });
  const navigationHistoryRef = useRef([{ view: 'home' }]);
  const navigationIndexRef = useRef(0);
  const [navigationPosition, setNavigationPosition] = useState({ index: 0, length: 1 });

  const mapAbortRef = useRef(null);
  const hotspotAbortRef = useRef(null);
  const outcomeDataAbortRef = useRef(null);
  const graphAbortRef = useRef(new Map());
  const subregionGeometryAbortRef = useRef(null);
  const appContentRef = useRef(null);
  const selectedAnalysisItemsRef = useRef([]);
  const analysisGraphEntriesRef = useRef({});
  const analysisGraphResizeRef = useRef(null);
  const activeYearRange = selectedYearRange.start !== null && selectedYearRange.end !== null
    ? selectedYearRange
    : null;
  const fullDatasetYearRange = useMemo(() => (
    yearOptions.length > 0
      ? { start: yearOptions[0], end: yearOptions[yearOptions.length - 1] }
      : null
  ), [yearOptions]);
  const datasetContextKey = activeYearRange
    ? `${datasetId}:${activeYearRange.start}-${activeYearRange.end}`
    : '';
  const selectedVariableReady = Boolean(
    datasetContextKey
    && variablesContextKey === datasetContextKey
    && selectedVariable
    && variables.includes(selectedVariable)
  );
  const selectedSubregion = subregions.find((item) => item.id === selectedSubregionId) || null;
  const roiPolygon = aoiPolygons[0] || null;
  const selectedPolygon = aoiPolygons.find((polygon) => polygon.id === selectedAoiId) || null;
  const selectedAoiQueryKey = roiPolygon
    ? JSON.stringify({ id: roiPolygon.id, geometry: roiPolygon.geometry })
    : '';
  const glacierRoiSearchBounds = useMemo(
    () => expandBoundsByKm(roiPolygon?.analysis?.bounds, 5),
    [selectedAoiQueryKey]
  );
  const selectedMapBounds = useMemo(() => {
    const bounds = selectedSubregion?.bounds;
    if (bounds) {
      const mapped = {
        minLat: Number(bounds.min_lat),
        maxLat: Number(bounds.max_lat),
        minLon: Number(bounds.min_lon),
        maxLon: Number(bounds.max_lon),
      };
      if (Object.values(mapped).every(Number.isFinite)) return mapped;
    }
    return getGeoJsonBounds(selectedSubregionFeature);
  }, [selectedSubregion, selectedSubregionFeature]);
  const basinSubregions = useMemo(
    () => subregions.filter((item) => item.kind !== 'glacier'),
    [subregions]
  );
  const glacierSubregions = useMemo(
    () => subregions.filter((item) => item.kind === 'glacier'),
    [subregions]
  );
  const normalizedSubregionQuery = subregionSearchText.trim().toLowerCase();
  const filteredBasinSubregions = useMemo(() => {
    const items = normalizedSubregionQuery
      ? basinSubregions.filter((item) => {
        const searchText = `${item.label || ''} ${item.id || ''} basin`.toLowerCase();
        return searchText.includes(normalizedSubregionQuery);
      })
      : basinSubregions;
    return items.slice(0, normalizedSubregionQuery ? 20 : 8);
  }, [basinSubregions, normalizedSubregionQuery]);
  const filteredGlacierSubregions = useMemo(() => {
    const roiScopedGlaciers = glacierRoiSearchBounds
      ? glacierSubregions.filter((item) => boundsIntersect(getSubregionBounds(item), glacierRoiSearchBounds))
      : glacierSubregions;
    const items = normalizedSubregionQuery
      ? roiScopedGlaciers.filter((item) => {
        const searchText = `${item.label || ''} ${item.id || ''} glacier`.toLowerCase();
        return searchText.includes(normalizedSubregionQuery);
      })
      : roiScopedGlaciers;
    return items.slice(0, normalizedSubregionQuery ? 20 : 12);
  }, [glacierRoiSearchBounds, glacierSubregions, normalizedSubregionQuery]);
  const isHotspotMode = analysisMode === 'hotspot';
  const isOutcomeMode = analysisMode === 'outcome';
  const glacierViewEnabled = mapViewMode === 'glacier';
  const abortGraphRequests = useCallback(() => {
    graphAbortRef.current.forEach((entry) => entry?.controller?.abort?.());
    graphAbortRef.current.clear();
  }, []);
  const selectedDataset = datasets.find((d) => d.id === datasetId);
  const selectedOutcome = outcomes.find((item) => item.id === selectedOutcomeId) || null;
  const activeAnalysisItem = selectedAnalysisItems[0] || null;
  const selectedAnalysisIdSet = useMemo(
    () => new Set(selectedAnalysisItems.map((item) => item.id)),
    [selectedAnalysisItems]
  );
  const variableLabel = formatVariableLabel(selectedVariable);
  const activeContextComparisonVariables = useMemo(() => (
    selectedAnalysisItems
      .filter((item) => (
        item.datasetId === datasetId
        && sameYearRange(item.yearRange, activeYearRange)
        && item.variable !== selectedVariable
        && variables.includes(item.variable)
      ))
      .map((item) => item.variable)
  ), [activeYearRange, datasetId, selectedAnalysisItems, selectedVariable, variables]);
  const hasResearchMapOutput = researchPanelOpen && Array.isArray(researchMapOutput?.data) && researchMapOutput.data.length > 0;
  const hasCodeMapOutput = codePanelOpen && Array.isArray(codeMapOutput?.data) && codeMapOutput.data.length > 0;
  const hasToolMapOutput = hasResearchMapOutput || hasCodeMapOutput;
  const activeToolMapOutput = hasResearchMapOutput ? researchMapOutput : codeMapOutput;
  const outcomeBand = useMemo(() => (
    (outcomeMeta?.bands || []).find((band) => String(band.id) === String(outcomeBandId)) || null
  ), [outcomeMeta, outcomeBandId]);
  const outcomeComparison = useMemo(() => (
    (outcomeMeta?.comparisons || []).find((comparison) => String(comparison.id) === String(outcomeComparisonId)) || null
  ), [outcomeMeta, outcomeComparisonId]);
  const outcomeAvailableBandIds = useMemo(() => {
    const coverageList = outcomeMeta?.coverage_by_variable?.[outcomeVariable];
    if (!coverageList) {
      return new Set((outcomeMeta?.bands || []).map((band) => String(band.id)));
    }
    return new Set(
      coverageList
        .filter((coverage) => (coverage.available_years || []).length > 0)
        .map((coverage) => String(coverage.band_id))
    );
  }, [outcomeMeta, outcomeVariable]);
  const outcomeCoverage = useMemo(() => {
    const coverageList = outcomeMeta?.coverage_by_variable?.[outcomeVariable] || outcomeMeta?.coverage_by_band;
    if (!coverageList) return null;
    return coverageList.find((coverage) => String(coverage.band_id) === String(outcomeBandId)) || null;
  }, [outcomeMeta, outcomeBandId, outcomeVariable]);
  const isOutcomeDifferenceMode = outcomeViewMode === 'difference';
  const outcomeAggregation = outcomeMeta?.aggregation_by_variable?.[outcomeVariable] || 'mean';
  const outcomeAggregationLabel = outcomeAggregation === 'sum' ? 'Sum' : 'Mean';
  const outcomeMapTitle = isOutcomeDifferenceMode
    ? (outcomeComparison?.label ? `Change: ${outcomeComparison.label}` : 'Saved Outcome Change')
    : (outcomeBand?.label ? `Band: ${outcomeBand.label}` : 'Saved Outcome');
  const outcomeVariableLabel = isOutcomeDifferenceMode
    ? `${formatVariableLabel(outcomeVariable)} Change`
    : formatVariableLabel(outcomeVariable);
  const displayedMapData = hasToolMapOutput ? activeToolMapOutput.data : isOutcomeMode ? outcomeData : isHotspotMode ? hotspotData : mapData;
  const hotspotMinYearsMax = activeYearRange
    ? Math.max(2, activeYearRange.end - activeYearRange.start + 1)
    : 2;
  const mapPointCount = displayedMapData.length;
  const displayedVariableLabel = hasToolMapOutput ? (activeToolMapOutput.label || 'Derived Result') : isOutcomeMode ? outcomeVariableLabel : variableLabel;
  const displayedAnalysisMode = hasToolMapOutput || isOutcomeMode ? 'daily' : analysisMode;
  const displayedLayerStyle = hasToolMapOutput
    ? activeToolMapOutput.style
    : isOutcomeMode && isOutcomeDifferenceMode
      ? { palette: 'blue_red' }
      : null;
  const displayedMapDate = isOutcomeMode ? outcomeMapTitle : currentDate;
  const mapRequestKey = useMemo(() => [
    datasetId,
    activeYearRange?.start,
    activeYearRange?.end,
    currentDate,
    selectedElevRange.min,
    selectedElevRange.max,
    selectedVariable,
    selectedSubregionId,
    selectedAoiQueryKey,
  ].join('|'), [
    datasetId,
    activeYearRange?.start,
    activeYearRange?.end,
    currentDate,
    selectedElevRange.min,
    selectedElevRange.max,
    selectedVariable,
    selectedSubregionId,
    selectedAoiQueryKey,
  ]);
  const [mapFrameReadyKey, setMapFrameReadyKey] = useState('');
  const codeToolStateForProjectStorage = useMemo(
    () => getCodeStateForProjectStorage(projectToolState.code || {}),
    [projectToolState.code]
  );

  const projectWorkspaceSnapshot = useMemo(() => ({
    schemaVersion: 1,
    view: showDocumentation ? 'documentation' : (analysisMode === 'outcome' ? 'outcome' : 'dashboard'),
    dashboard: {
      datasetId,
      selectedOutcomeId,
      selectedYearRange,
      currentDate,
      selectedVariable,
      comparisonVariables: activeContextComparisonVariables,
      analysisItems: selectedAnalysisItems,
      selectedSubregionId,
      aoiPolygons,
      selectedAoiId,
      focusLocations,
      selectedElevRange,
      mapViewMode,
      analysisMode,
      hotspotMinYears,
      outcomeVariable,
      outcomeBandId,
      outcomeViewMode,
      outcomeComparisonId,
    },
    layout: {
      theme,
      bottomPanelHeight,
      codePanelWidth,
      codePanelOpen,
      researchPanelOpen,
    },
    tools: {
      code: codeToolStateForProjectStorage,
      research: projectToolState.research,
    },
  }), [
    analysisMode,
    bottomPanelHeight,
    codePanelOpen,
    codePanelWidth,
    activeContextComparisonVariables,
    currentDate,
    datasetId,
    hotspotMinYears,
    mapViewMode,
    outcomeBandId,
    outcomeComparisonId,
    outcomeVariable,
    outcomeViewMode,
    codeToolStateForProjectStorage,
    projectToolState.research,
    aoiPolygons,
    selectedAoiId,
    focusLocations,
    researchPanelOpen,
    selectedElevRange,
    selectedAnalysisItems,
    selectedOutcomeId,
    selectedSubregionId,
    selectedVariable,
    selectedYearRange,
    showDocumentation,
    theme,
  ]);

  const projectWorkspaceFingerprint = useMemo(
    () => buildProjectFingerprint(projectWorkspaceSnapshot, projectToolState.code?.code || ''),
    [projectToolState.code?.code, projectWorkspaceSnapshot]
  );

  useEffect(() => {
    latestProjectFingerprintRef.current = projectWorkspaceFingerprint;
  }, [projectWorkspaceFingerprint]);

  const handleCodeWorkspaceStateChange = useCallback((state) => {
    setProjectToolState((current) => ({ ...current, code: state }));
  }, []);

  const handleResearchWorkspaceStateChange = useCallback((state) => {
    setProjectToolState((current) => ({ ...current, research: state }));
  }, []);

  useEffect(() => {
    if (!activeProject || !projectBaselineRef.current) return;
    setProjectDirty(projectWorkspaceFingerprint !== projectBaselineRef.current);
  }, [activeProject, projectWorkspaceFingerprint]);

  useEffect(() => () => {
    if (projectRestoreTimerRef.current) window.clearTimeout(projectRestoreTimerRef.current);
  }, []);

  const applyNavigationEntry = useCallback((entry) => {
    const view = entry?.view || 'home';
    const documentationBase = entry?.baseView || 'home';

    setIsPlaying(false);
    setSearchToolsOpen(false);
    setActiveToolPanel('');
    setRegionSelectMode(false);
    setPolygonDrawMode(false);
    setRegionPreview(null);
    setCodePanelOpen(false);
    setCodeMapOutput(null);
    setResearchPanelOpen(false);
    setResearchMapOutput(null);
    setError(null);

    if (view === 'documentation') {
      setShowDocumentation(true);
      setDatasetReady(documentationBase === 'dashboard' || documentationBase === 'outcome');
      if (documentationBase === 'outcome') {
        setAnalysisMode('outcome');
      }
      return;
    }

    setShowDocumentation(false);
    setDatasetReady(view === 'dashboard' || view === 'outcome');
    if (view === 'outcome') {
      setAnalysisMode('outcome');
    }
  }, []);

  const recordNavigation = useCallback((entry) => {
    const currentIndex = navigationIndexRef.current;
    const currentEntry = navigationHistoryRef.current[currentIndex];
    const isSameEntry = currentEntry?.view === entry.view
      && currentEntry?.baseView === entry.baseView;
    if (isSameEntry) return;

    const nextHistory = [
      ...navigationHistoryRef.current.slice(0, currentIndex + 1),
      entry,
    ];
    const nextIndex = nextHistory.length - 1;
    navigationHistoryRef.current = nextHistory;
    navigationIndexRef.current = nextIndex;
    setNavigationPosition({ index: nextIndex, length: nextHistory.length });
  }, []);

  const handleNavigateBack = useCallback(() => {
    const nextIndex = navigationIndexRef.current - 1;
    if (nextIndex < 0) return;
    navigationIndexRef.current = nextIndex;
    setNavigationPosition({ index: nextIndex, length: navigationHistoryRef.current.length });
    applyNavigationEntry(navigationHistoryRef.current[nextIndex]);
  }, [applyNavigationEntry]);

  const handleNavigateForward = useCallback(() => {
    const nextIndex = navigationIndexRef.current + 1;
    if (nextIndex >= navigationHistoryRef.current.length) return;
    navigationIndexRef.current = nextIndex;
    setNavigationPosition({ index: nextIndex, length: navigationHistoryRef.current.length });
    applyNavigationEntry(navigationHistoryRef.current[nextIndex]);
  }, [applyNavigationEntry]);

  const navigationControls = (
    <NavigationControls
      canGoBack={navigationPosition.index > 0}
      canGoForward={navigationPosition.index < navigationPosition.length - 1}
      onBack={handleNavigateBack}
      onForward={handleNavigateForward}
    />
  );

  useEffect(() => {
    const handleHistoryShortcut = (event) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        handleNavigateBack();
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        handleNavigateForward();
      }
    };

    window.addEventListener('keydown', handleHistoryShortcut);
    return () => window.removeEventListener('keydown', handleHistoryShortcut);
  }, [handleNavigateBack, handleNavigateForward]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    const warmVisualizationModules = () => {
      Promise.allSettled([
        import('./components/MapView'),
        import('./components/TempGraph'),
      ]);
    };

    if ('requestIdleCallback' in window) {
      const idleId = window.requestIdleCallback(warmVisualizationModules, { timeout: 1500 });
      return () => window.cancelIdleCallback(idleId);
    }
    const timer = window.setTimeout(warmVisualizationModules, 250);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    localStorage.setItem('bottomPanelHeight', String(bottomPanelHeight));
  }, [bottomPanelHeight]);

  useEffect(() => {
    localStorage.setItem('codePanelWidth', String(codePanelWidth));
  }, [codePanelWidth]);

  useEffect(() => {
    selectedAnalysisItemsRef.current = selectedAnalysisItems;
  }, [selectedAnalysisItems]);

  useEffect(() => {
    analysisGraphEntriesRef.current = analysisGraphEntries;
  }, [analysisGraphEntries]);

  useEffect(() => {
    localStorage.setItem('analysisGraphHeights', JSON.stringify(analysisGraphHeights));
  }, [analysisGraphHeights]);

  useEffect(() => {
    setComparisonVariables((prev) => {
      const isSame = prev.length === activeContextComparisonVariables.length
        && prev.every((variable, index) => variable === activeContextComparisonVariables[index]);
      return isSame ? prev : activeContextComparisonVariables;
    });
  }, [activeContextComparisonVariables]);

  useEffect(() => {
    setCodeMapOutput(null);
  }, [
    datasetId,
    currentDate,
    selectedVariable,
    selectedElevRange.min,
    selectedElevRange.max,
    selectedSubregionId,
    selectedAoiQueryKey,
    activeYearRange?.start,
    activeYearRange?.end,
  ]);

  const handleBottomResizeStart = useCallback((event) => {
    event.preventDefault();

    const handleMouseMove = (moveEvent) => {
      const contentRect = appContentRef.current?.getBoundingClientRect();
      if (!contentRect) return;
      const availableHeight = contentRect.height;
      const nextHeight = contentRect.bottom - moveEvent.clientY;
      setBottomPanelHeight(clamp(nextHeight, 180, Math.max(220, availableHeight - 220)));
      window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    };

    const handleMouseUp = () => {
      document.body.classList.remove('is-resizing-bottom');
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    document.body.classList.add('is-resizing-bottom');
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, []);

  const handleAnalysisGraphResizeStart = useCallback((itemId, event) => {
    event.preventDefault();
    const card = event.currentTarget.closest('.analysis-graph-card');
    if (!card) return;
    const startHeight = card.getBoundingClientRect().height;
    const startY = event.clientY;
    analysisGraphResizeRef.current = itemId;
    document.body.classList.add('is-resizing-analysis-graph');

    const handleMouseMove = (moveEvent) => {
      const nextHeight = clamp(startHeight + moveEvent.clientY - startY, 270, 680);
      setAnalysisGraphHeights((prev) => ({ ...prev, [itemId]: nextHeight }));
    };
    const handleMouseUp = () => {
      analysisGraphResizeRef.current = null;
      document.body.classList.remove('is-resizing-analysis-graph');
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, []);

  const handleCodeResizeStart = useCallback((event) => {
    event.preventDefault();

    const handleMouseMove = (moveEvent) => {
      const contentRect = appContentRef.current?.getBoundingClientRect();
      if (!contentRect) return;
      const availableWidth = contentRect.width;
      const nextWidth = moveEvent.clientX - contentRect.left;
      setCodePanelWidth(clamp(nextWidth, 360, Math.max(360, availableWidth - 320)));
      window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    };

    const handleMouseUp = () => {
      document.body.classList.remove('is-resizing-sidebar');
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    document.body.classList.add('is-resizing-sidebar');
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, []);

  const loadHomeOptions = useCallback(async () => {
    try {
      setDatasetLoading(true);
      const [datasetsResponse, outcomesResponse, projectsResponse, configResponse] = await Promise.all([
        apiService.getDatasets(),
        apiService.getOutcomes().catch(() => ({ outcomes: [] })),
        apiService.getProjects().catch((projectError) => {
          console.warn('Could not load saved projects:', projectError);
          setProjectsError('Saved projects are unavailable from this backend.');
          return { projects: [] };
        }),
        apiService.getDatasetConfig().catch(() => null),
      ]);
      const list = datasetsResponse.datasets || [];
      const outcomeList = outcomesResponse.outcomes || [];
      setDatasets(list);
      setOutcomes(outcomeList);
      setProjects(projectsResponse.projects || []);
      if (configResponse) {
        setDatasetConfig(configResponse);
      }
      if (outcomeList.length > 0) {
        const firstOutcome = outcomeList.find((item) => item.ready) || outcomeList[0];
        setSelectedOutcomeId(firstOutcome.id);
      }
      const preferred = list.find((d) => d.id === datasetsResponse.default_dataset && d.ready);
      const firstReady = list.find((d) => d.ready);
      const firstAny = list[0];
      setDatasetId((preferred || firstReady || firstAny)?.id || '');

      // If dataset is found empty / almost empty, open the dataset path configuration modal
      const isDbEmpty = !firstReady || (configResponse && (configResponse.is_empty || configResponse.ready_datasets === 0));
      if (isDbEmpty) {
        setDatasetConfigModalOpen(true);
      }
    } catch (err) {
      console.error('Failed to load datasets:', err);
      setError('Failed to load dataset list from backend.');
    } finally {
      setDatasetLoading(false);
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHomeOptions();
  }, [loadHomeOptions]);

  const handleDatasetPathConfigured = useCallback(async () => {
    apiService.clearCache();
    await loadHomeOptions();
  }, [loadHomeOptions]);

  useEffect(() => {
    if (!selectedOutcome?.ready) {
      setOutcomeMeta(null);
      setOutcomeMetaError('');
      setOutcomeVariable('');
      setOutcomeBandId('');
      setOutcomeComparisonId('');
      return;
    }

    let isMounted = true;
    const loadOutcomeMeta = async () => {
      try {
        setOutcomeMetaLoading(true);
        setOutcomeMetaError('');
        const response = await apiService.getOutcomeMeta(selectedOutcome.id);
        if (!isMounted) return;
        const restoredDashboard = projectRestoreSnapshotRef.current?.workspace?.dashboard || {};
        const canRestoreOutcome = restoredDashboard.selectedOutcomeId === selectedOutcome.id;
        const restoredVariable = canRestoreOutcome && (response.variables || []).includes(restoredDashboard.outcomeVariable)
          ? restoredDashboard.outcomeVariable
          : ((response.variables || [])[0] || '');
        const restoredBand = canRestoreOutcome && (response.bands || []).some((band) => String(band.id) === String(restoredDashboard.outcomeBandId))
          ? String(restoredDashboard.outcomeBandId)
          : String((response.bands || [])[0]?.id || '');
        const restoredComparison = canRestoreOutcome && (response.comparisons || []).some((comparison) => String(comparison.id) === String(restoredDashboard.outcomeComparisonId))
          ? String(restoredDashboard.outcomeComparisonId)
          : String((response.comparisons || [])[0]?.id || '');
        setOutcomeMeta(response);
        setOutcomeVariable(restoredVariable);
        setOutcomeBandId(restoredBand);
        setOutcomeComparisonId(restoredComparison);
      } catch (err) {
        if (!isMounted) return;
        const detail = err?.response?.data?.detail;
        setOutcomeMeta(null);
        setOutcomeMetaError(detail || 'Failed to load outcome metadata.');
      } finally {
        if (isMounted) {
          setOutcomeMetaLoading(false);
        }
      }
    };

    loadOutcomeMeta();
    return () => {
      isMounted = false;
    };
  }, [selectedOutcome?.id, selectedOutcome?.ready]);

  useEffect(() => {
    if (!outcomeMeta || !outcomeVariable || outcomeAvailableBandIds.size === 0) return;

    if (!outcomeAvailableBandIds.has(String(outcomeBandId))) {
      const firstAvailableBand = (outcomeMeta.bands || []).find((band) => outcomeAvailableBandIds.has(String(band.id)));
      setOutcomeBandId(String(firstAvailableBand?.id || ''));
    }

    const validComparisons = (outcomeMeta.comparisons || []).filter(
      (comparison) => outcomeAvailableBandIds.has(String(comparison.earlier_band_id))
        && outcomeAvailableBandIds.has(String(comparison.later_band_id))
    );
    if (!validComparisons.some((comparison) => String(comparison.id) === String(outcomeComparisonId))) {
      setOutcomeComparisonId(String(validComparisons[0]?.id || ''));
    }
  }, [outcomeAvailableBandIds, outcomeBandId, outcomeComparisonId, outcomeMeta, outcomeVariable]);

  useEffect(() => {
    if ((isHotspotMode || isOutcomeMode) && isPlaying) {
      setIsPlaying(false);
    }
  }, [isHotspotMode, isOutcomeMode, isPlaying]);

  useEffect(() => {
    if (!activeYearRange) return;
    const maxAllowed = Math.max(2, activeYearRange.end - activeYearRange.start + 1);
    setHotspotMinYears((prev) => Math.min(maxAllowed, Math.max(2, prev)));
  }, [activeYearRange]);

  useEffect(() => {
    let isActive = true;
    const loadSubregions = async () => {
      try {
        setSubregionsLoading(true);
        const response = await apiService.getSubregions();
        if (!isActive) return;
        setSubregions(response.subregions || []);
      } catch (err) {
        if (!isActive) return;
        console.warn('Failed to load subregions:', err);
        setSubregions([]);
      } finally {
        if (isActive) {
          setSubregionsLoading(false);
        }
      }
    };

    loadSubregions();
    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    if (!selectedSubregionId) {
      subregionGeometryAbortRef.current?.abort?.();
      setSelectedSubregionFeature(null);
      return;
    }

    const controller = new AbortController();
    if (subregionGeometryAbortRef.current) {
      subregionGeometryAbortRef.current.abort();
    }
    subregionGeometryAbortRef.current = controller;

    const loadSubregionGeometry = async () => {
      try {
        const response = await apiService.getSubregionGeometry(selectedSubregionId, controller.signal);
        if (!controller.signal.aborted) {
          setSelectedSubregionFeature(response?.feature || null);
        }
      } catch (err) {
        const isCanceled = err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED';
        if (isCanceled) return;
        console.warn('Failed to load subregion geometry:', err);
        if (!controller.signal.aborted) {
          setSelectedSubregionFeature(null);
        }
      }
    };

    loadSubregionGeometry();
    return () => controller.abort();
  }, [selectedSubregionId]);

  useEffect(() => {
    if (!datasetId) {
      setYearOptions([]);
      setSelectedYearRange({ start: null, end: null });
      setYearRangeError('');
      return;
    }

    let isActive = true;
    const loadDatasetYears = async () => {
      try {
        setYearRangeLoading(true);
        setYearRangeError('');
        const response = await apiService.getAvailableYears(datasetId);
        const years = (response.years || [])
          .map((year) => Number(year))
          .filter((year) => Number.isInteger(year))
          .sort((a, b) => a - b);

        if (!isActive) return;
        setYearOptions(years);

        if (years.length === 0) {
          setSelectedYearRange({ start: null, end: null });
          setYearRangeError(`No years found for dataset '${datasetId}'.`);
          setLoading(false);
          return;
        }

        const minYear = Number.isInteger(response.min_year) ? response.min_year : years[0];
        const maxYear = Number.isInteger(response.max_year) ? response.max_year : years[years.length - 1];
        const defaultEndYear = maxYear;
        const defaultStartYear = Math.max(minYear, defaultEndYear - 1);

        setSelectedYearRange((prev) => {
          const restoredDashboard = projectRestoreSnapshotRef.current?.workspace?.dashboard || {};
          const restoredRange = restoredDashboard.datasetId === datasetId ? restoredDashboard.selectedYearRange : null;
          const restoredStart = Number(restoredRange?.start);
          const restoredEnd = Number(restoredRange?.end);
          const hasRestoredSelection = Number.isInteger(restoredStart) && Number.isInteger(restoredEnd);
          const hasExistingSelection = Number.isInteger(prev.start) && Number.isInteger(prev.end);
          const currentStart = hasRestoredSelection ? restoredStart : hasExistingSelection ? prev.start : defaultStartYear;
          const currentEnd = hasRestoredSelection ? restoredEnd : hasExistingSelection ? prev.end : defaultEndYear;
          const nextStart = Math.min(Math.max(currentStart, minYear), maxYear);
          const nextEnd = Math.min(Math.max(currentEnd, minYear), maxYear);
          return {
            start: Math.min(nextStart, nextEnd),
            end: Math.max(nextStart, nextEnd),
          };
        });
      } catch (err) {
        if (!isActive) return;
        console.error('Failed to load years:', err);
        setYearOptions([]);
        setSelectedYearRange({ start: null, end: null });
        setYearRangeError('Failed to load available years for selected dataset.');
        setLoading(false);
      } finally {
        if (isActive) {
          setYearRangeLoading(false);
        }
      }
    };

    loadDatasetYears();
    return () => {
      isActive = false;
    };
  }, [datasetId]);

  // Initialize: Load dates and elevation range
  useEffect(() => {
    if (!datasetReady || !datasetId || !activeYearRange) {
      if (!activeYearRange) {
        setLoading(false);
      }
      return;
    }

    const initialize = async () => {
      const contextKey = `${datasetId}:${activeYearRange.start}-${activeYearRange.end}`;
      try {
        setLoading(true);
        setError(null);
        setVariables([]);
        setSelectedVariable('');
        setComparisonVariables([]);
        setVariablesContextKey('');
        setMapData([]);
        setHotspotData([]);

        const restoredDashboard = pendingProjectRestoreRef.current?.workspace?.dashboard || {};

        // Fixed elevation band for all datasets.
        setElevationRange({ min: 500, max: 9000 });
        setSelectedElevRange(restoredDashboard.selectedElevRange || { min: 500, max: 9000 });

        // Fetch stats (optional - non-blocking)
        apiService.getStats(datasetId, activeYearRange)
          .then(statsResponse => setStats(statsResponse))
          .catch(err => console.warn('Could not load stats:', err));

        const varResponse = await apiService.getAvailableVariables(datasetId, activeYearRange);
        if (varResponse.variables && varResponse.variables.length > 0) {
          const shouldDeferVariable = Boolean(restoredDashboard.deferVariableSelection);
          const restoredItems = normalizeAnalysisItems(restoredDashboard.analysisItems, restoredDashboard);
          const restoredActiveItem = restoredItems.find((item) => (
            item.datasetId === datasetId
            && sameYearRange(item.yearRange, activeYearRange)
            && varResponse.variables.includes(item.variable)
          ));
          const existingContextItem = selectedAnalysisItemsRef.current.find((item) => (
            item.datasetId === datasetId
            && sameYearRange(item.yearRange, activeYearRange)
            && varResponse.variables.includes(item.variable)
          ));
          const legacyRestoredVariable = restoredDashboard.datasetId === datasetId
            && sameYearRange(restoredDashboard.selectedYearRange, activeYearRange)
            && varResponse.variables.includes(restoredDashboard.selectedVariable)
            ? restoredDashboard.selectedVariable
            : '';
          const restoredVariable = restoredActiveItem?.variable
            || legacyRestoredVariable
            || existingContextItem?.variable
            || (shouldDeferVariable ? '' : (varResponse.default_variable || varResponse.variables[0]));
          setVariables(varResponse.variables);
          setSelectedVariable(restoredVariable);
          setVariablesContextKey(contextKey);
          if (restoredItems.length > 0) {
            setSelectedAnalysisItems(restoredItems);
          } else if (restoredVariable) {
            const nextItem = createAnalysisItem({
              datasetId,
              datasetLabel: selectedDataset?.label || datasetId,
              yearRange: activeYearRange,
              variable: restoredVariable,
            });
            setSelectedAnalysisItems((prev) => (
              nextItem
                ? [nextItem, ...prev.filter((item) => item.id !== nextItem.id)]
                : prev
            ));
          } else if (pendingProjectRestoreRef.current) {
            setSelectedAnalysisItems([]);
          }
        } else {
          setVariablesContextKey('');
          setError(`No variables available for dataset '${datasetId}'.`);
        }
        setLoading(false);

      } catch (err) {
        console.error('Initialization error:', err);
        setError('Failed to connect to backend. Please ensure the FastAPI server is running on port 8000.');
        setLoading(false);
      }
    };

    initialize();
  }, [datasetReady, datasetId, activeYearRange]);

  useEffect(() => {
    if (!datasetReady || !datasetId || !activeYearRange || !selectedVariableReady || isOutcomeMode) return;

    const controller = new AbortController();
    const loadDatesForVariable = async () => {
      try {
        const restoredDashboard = projectRestoreSnapshotRef.current?.workspace?.dashboard || {};
        const datesResponse = await apiService.getAvailableDates(datasetId, activeYearRange);
        if (controller.signal.aborted) return;
        if (datesResponse.dates && datesResponse.dates.length > 0) {
          const restoredDate = restoredDashboard.datasetId === datasetId
            && restoredDashboard.selectedVariable === selectedVariable
            && datesResponse.dates.includes(restoredDashboard.currentDate)
            ? restoredDashboard.currentDate
            : datesResponse.dates[0];
          setDates(datesResponse.dates);
          setCurrentDate(restoredDate);
          setCurrentDateIndex(Math.max(0, datesResponse.dates.indexOf(restoredDate)));
          pendingProjectRestoreRef.current = null;
          if (projectRestoreTimerRef.current) window.clearTimeout(projectRestoreTimerRef.current);
          projectRestoreTimerRef.current = window.setTimeout(() => {
            projectBaselineRef.current = latestProjectFingerprintRef.current;
            setProjectDirty(false);
          }, 250);
        } else {
          setDates([]);
          setCurrentDate(null);
          setCurrentDateIndex(0);
          setError(`No dates found for ${formatVariableLabel(selectedVariable)} in ${activeYearRange.start}-${activeYearRange.end}.`);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        console.warn('Could not load dates:', err);
        setDates([]);
        setCurrentDate(null);
        setCurrentDateIndex(0);
        setError('Failed to load available dates for the selected variable.');
      }
    };

    loadDatesForVariable();
    return () => controller.abort();
  }, [activeYearRange, datasetId, datasetReady, isOutcomeMode, selectedVariable, selectedVariableReady]);

  // Fetch map data when date or elevation changes
  useEffect(() => {
    if (!datasetReady || !datasetId || !currentDate || !activeYearRange || !selectedVariableReady || isHotspotMode || isOutcomeMode) return;

    const controller = new AbortController();
    if (mapAbortRef.current) {
      mapAbortRef.current.abort();
    }
    mapAbortRef.current = controller;

    const fetchMapData = async () => {
      try {
        const response = await apiService.getData(
          currentDate,
          selectedElevRange.min,
          selectedElevRange.max,
          selectedVariable,
          datasetId,
          controller.signal,
          activeYearRange,
          roiPolygon ? undefined : (selectedSubregionId || undefined),
          roiPolygon || undefined
        );

        if (controller.signal.aborted) return;
        setMapData(response.data || []);
        setMapFrameReadyKey(mapRequestKey);

        if (response.query_time_ms) {
          console.log(`Query completed in ${response.query_time_ms}ms`);
        }
      } catch (err) {
        const isCanceled = err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED';
        if (isCanceled) return;
        console.error('Error fetching map data:', err);
        setMapData([]); // Clear map on error
      }
    };

    fetchMapData();

    return () => {
      controller.abort();
    };
  }, [datasetReady, datasetId, currentDate, selectedElevRange, selectedVariable, selectedVariableReady, activeYearRange, selectedSubregionId, roiPolygon, isHotspotMode, isOutcomeMode, mapRequestKey]);

  // Fetch hotspot trends for long-term change analysis
  useEffect(() => {
    if (!datasetReady || !datasetId || !activeYearRange || !selectedVariableReady || !isHotspotMode || isOutcomeMode) return;

    const controller = new AbortController();
    if (hotspotAbortRef.current) {
      hotspotAbortRef.current.abort();
    }
    hotspotAbortRef.current = controller;

    const fetchHotspots = async () => {
      try {
        setHotspotLoading(true);
        setHotspotError('');

        const response = await apiService.getHotspotTrends(
          selectedElevRange.min,
          selectedElevRange.max,
          selectedVariable,
          datasetId,
          controller.signal,
          activeYearRange,
          roiPolygon ? undefined : (selectedSubregionId || undefined),
          hotspotMinYears,
          roiPolygon || undefined
        );

        setHotspotData(response.data || []);
        setHotspotSummary(response.summary || null);
      } catch (err) {
        const isCanceled = err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED';
        if (isCanceled) return;
        console.error('Error fetching hotspot trends:', err);
        setHotspotData([]);
        setHotspotSummary(null);
        setHotspotError('Failed to compute hotspot trends for this selection.');
      } finally {
        if (!controller.signal.aborted) {
          setHotspotLoading(false);
        }
      }
    };

    fetchHotspots();
    return () => {
      controller.abort();
    };
  }, [
    datasetReady,
    datasetId,
    activeYearRange,
    selectedElevRange,
    selectedVariable,
    selectedVariableReady,
    selectedSubregionId,
    roiPolygon,
    isHotspotMode,
    isOutcomeMode,
    hotspotMinYears,
  ]);

  useEffect(() => {
    if (!datasetReady || !isOutcomeMode || !selectedOutcome?.ready || !outcomeVariable) return;
    if (outcomeViewMode === 'mean' && !outcomeBandId) return;
    if (outcomeViewMode === 'difference' && !outcomeComparisonId) return;

    const controller = new AbortController();
    if (outcomeDataAbortRef.current) {
      outcomeDataAbortRef.current.abort();
    }
    outcomeDataAbortRef.current = controller;

    const loadOutcomeData = async () => {
      try {
        setOutcomeDataLoading(true);
        setOutcomeDataError('');
        const response = outcomeViewMode === 'difference'
          ? await apiService.getOutcomeDifference(
            selectedOutcome.id,
            outcomeVariable,
            outcomeComparisonId,
            controller.signal,
            roiPolygon || undefined
          )
          : await apiService.getOutcomeData(
            selectedOutcome.id,
            outcomeVariable,
            outcomeBandId,
            controller.signal,
            roiPolygon || undefined
          );
        if (controller.signal.aborted) return;
        setOutcomeData(response.data || []);
        setOutcomeStats(response.stats || null);
      } catch (err) {
        const isCanceled = err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED';
        if (isCanceled) return;
        const detail = err?.response?.data?.detail;
        setOutcomeData([]);
        setOutcomeStats(null);
        setOutcomeDataError(detail || 'Failed to load saved outcome map.');
      } finally {
        if (!controller.signal.aborted) {
          setOutcomeDataLoading(false);
        }
      }
    };

    loadOutcomeData();
    return () => {
      controller.abort();
    };
  }, [
    datasetReady,
    isOutcomeMode,
    selectedOutcome?.id,
    selectedOutcome?.ready,
    outcomeVariable,
    outcomeBandId,
    outcomeComparisonId,
    outcomeViewMode,
    roiPolygon,
    selectedAoiQueryKey,
  ]);

  // Fetch graph data for every selected analysis item when filters change.
  useEffect(() => {
    if (!datasetReady || isOutcomeMode) return;

    const activeItems = selectedAnalysisItems.filter((item) => (
      item?.datasetId
      && item?.variable
      && normalizeYearRange(item.yearRange)
    ));

    if (activeItems.length === 0) {
      setAnalysisGraphEntries({});
      return;
    }

    const activeIds = new Set(activeItems.map((item) => item.id));
    setAnalysisGraphEntries((prev) => {
      let changed = false;
      const next = {};
      Object.entries(prev).forEach(([id, entry]) => {
        if (activeIds.has(id)) {
          next[id] = entry;
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });

    const inFlightGraphs = graphAbortRef.current;
    inFlightGraphs.forEach((entry, id) => {
      if (!activeIds.has(id)) {
        entry?.controller?.abort?.();
        inFlightGraphs.delete(id);
      }
    });

    const entries = analysisGraphEntriesRef.current;
    const itemsToLoad = activeItems
      .map((item) => ({
        item,
        requestKey: getAnalysisGraphRequestKey(item, selectedElevRange, selectedSubregionId, selectedAoiQueryKey),
      }))
      .filter(({ item, requestKey }) => {
        const entry = entries[item.id];
        const pending = inFlightGraphs.get(item.id);
        if (pending?.requestKey === requestKey) return false;
        return !(entry && entry.requestKey === requestKey && !entry.loading && !entry.error);
      });

    if (itemsToLoad.length === 0) return;

    setAnalysisGraphEntries((prev) => {
      const next = { ...prev };
      itemsToLoad.forEach(({ item, requestKey }) => {
        next[item.id] = {
          ...(next[item.id] || {}),
          requestKey,
          loading: true,
          error: '',
        };
      });
      return next;
    });

    const fetchGraphData = async () => {
      let nextIndex = 0;
      const loadOne = async ({ item, requestKey }) => {
        const existing = inFlightGraphs.get(item.id);
        if (existing && existing.requestKey !== requestKey) {
          existing.controller?.abort?.();
        }

        const controller = new AbortController();
        inFlightGraphs.set(item.id, { requestKey, controller });
        try {
          const datesResponse = await apiService.getAvailableDates(item.datasetId, item.yearRange);
          if (controller.signal.aborted) return;
          const itemDates = datesResponse.dates || [];
          if (itemDates.length === 0) {
            setAnalysisGraphEntries((prev) => ({
              ...prev,
              [item.id]: {
                ...(prev[item.id] || {}),
                requestKey,
                data: [],
                loading: false,
                error: `No dates found for ${item.variableLabel}.`,
              },
            }));
            return;
          }

          const response = await apiService.getBasinMean(
            itemDates[0],
            itemDates[itemDates.length - 1],
            selectedElevRange.min,
            selectedElevRange.max,
            item.variable,
            item.datasetId,
            controller.signal,
            item.yearRange,
            roiPolygon ? undefined : (selectedSubregionId || undefined),
            roiPolygon || undefined
          );

          if (controller.signal.aborted) return;
          const currentEntry = analysisGraphEntriesRef.current[item.id];
          const stillSelected = selectedAnalysisItemsRef.current.some((candidate) => candidate.id === item.id);
          if (!stillSelected || (currentEntry && currentEntry.requestKey !== requestKey)) return;
          setAnalysisGraphEntries((prev) => ({
            ...prev,
            [item.id]: {
              requestKey,
              data: response.data || [],
              loading: false,
              error: '',
            },
          }));
        } catch (err) {
          const isCanceled = err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED';
          if (isCanceled || controller.signal.aborted) return;
          console.error(`Error fetching graph data for ${item.id}:`, err);
          const currentEntry = analysisGraphEntriesRef.current[item.id];
          if (currentEntry && currentEntry.requestKey !== requestKey) return;
          setAnalysisGraphEntries((prev) => ({
            ...prev,
            [item.id]: {
              ...(prev[item.id] || {}),
              requestKey,
              loading: false,
              error: 'Could not load this analysis graph.',
            },
          }));
        } finally {
          const pending = inFlightGraphs.get(item.id);
          if (pending?.requestKey === requestKey) {
            inFlightGraphs.delete(item.id);
          }
        }
      };

      const workers = Array.from(
        { length: Math.min(GRAPH_FETCH_CONCURRENCY, itemsToLoad.length) },
        async () => {
          while (nextIndex < itemsToLoad.length) {
            const item = itemsToLoad[nextIndex];
            nextIndex += 1;
            await loadOne(item);
          }
        }
      );
      await Promise.all(workers);
    };

    // Delay graph load slightly to prioritize the active map frame.
    const timer = setTimeout(fetchGraphData, roiPolygon || selectedSubregionId ? 160 : 450);
    return () => {
      clearTimeout(timer);
    };
  }, [
    datasetReady,
    selectedAnalysisItems,
    selectedElevRange.min,
    selectedElevRange.max,
    selectedSubregionId,
    roiPolygon,
    selectedAoiQueryKey,
    isOutcomeMode,
    abortGraphRequests,
  ]);

  // Keep one frame ahead in the bounded cache. Playback only advances after
  // the visible frame is ready, preventing slow requests from being cancelled
  // repeatedly at 2x/5x speed.
  useEffect(() => {
    if (!isPlaying || isHotspotMode || isOutcomeMode || mapFrameReadyKey !== mapRequestKey) return undefined;
    const nextIndex = currentDateIndex + 1;
    if (nextIndex >= dates.length) return undefined;

    apiService.prefetchData(
      dates[nextIndex],
      selectedElevRange.min,
      selectedElevRange.max,
      selectedVariable,
      datasetId,
      activeYearRange,
      roiPolygon ? undefined : (selectedSubregionId || undefined),
      roiPolygon || undefined
    ).catch(() => {
      // The foreground request remains the source of truth if prefetch fails.
    });
    return undefined;
  }, [
    isPlaying,
    isHotspotMode,
    isOutcomeMode,
    mapFrameReadyKey,
    mapRequestKey,
    currentDateIndex,
    dates,
    selectedElevRange.min,
    selectedElevRange.max,
    selectedVariable,
    datasetId,
    activeYearRange,
    selectedSubregionId,
    roiPolygon,
  ]);

  useEffect(() => {
    if (!isPlaying || isHotspotMode || isOutcomeMode || mapFrameReadyKey !== mapRequestKey || dates.length === 0) {
      return undefined;
    }

    const timer = window.setTimeout(() => {
      setCurrentDateIndex((prevIndex) => {
        const nextIndex = prevIndex + 1;
        if (nextIndex >= dates.length) {
          setIsPlaying(false);
          setCurrentDate(dates[0] || null);
          return 0;
        }
        setCurrentDate(dates[nextIndex]);
        return nextIndex;
      });
    }, playSpeed);

    return () => window.clearTimeout(timer);
  }, [isPlaying, isHotspotMode, isOutcomeMode, mapFrameReadyKey, mapRequestKey, dates, playSpeed]);

  // Handle date change
  const handleDateChange = useCallback((index) => {
    setCurrentDateIndex(index);
    setCurrentDate(dates[index]);
    setIsPlaying(false);
  }, [dates]);

  // Handle play/pause
  const handlePlayPause = useCallback(() => {
    setIsPlaying((prev) => !prev);
  }, []);

  // Handle speed change
  const handleSpeedChange = useCallback((speed) => {
    setPlaySpeed(speed);
  }, []);

  // Handle elevation change
  const handleElevationChange = useCallback((min, max) => {
    setSelectedElevRange({ min, max });
  }, []);

  const handleAnalysisModeChange = useCallback((mode) => {
    const nextMode = ['daily', 'hotspot', 'outcome'].includes(mode) ? mode : 'daily';
    setAnalysisMode(nextMode);
    setHotspotError('');
    setOutcomeDataError('');
    if (nextMode !== 'daily') {
      setIsPlaying(false);
    }
  }, []);

  const handlePrimaryVariableChange = useCallback((variable) => {
    if (!datasetId || !activeYearRange || !variable) return;
    const nextItem = createAnalysisItem({
      datasetId,
      datasetLabel: selectedDataset?.label || datasetId,
      yearRange: activeYearRange,
      variable,
    });
    if (!nextItem) return;
    setAnalysisMode((prev) => (prev === 'outcome' ? 'daily' : prev));
    setSelectedAnalysisItems((prev) => [
      nextItem,
      ...prev.filter((item) => item.id !== nextItem.id),
    ]);
    setSelectedVariable(variable);
    setIsPlaying(false);
  }, [activeYearRange, datasetId, selectedDataset?.label]);

  const handleActivateAnalysisItem = useCallback((itemId) => {
    const item = selectedAnalysisItems.find((candidate) => candidate.id === itemId);
    if (!item) return;
    setAnalysisMode((prev) => (prev === 'outcome' ? 'daily' : prev));
    setSelectedAnalysisItems((prev) => [
      item,
      ...prev.filter((candidate) => candidate.id !== item.id),
    ]);
    setDatasetId(item.datasetId);
    setSelectedYearRange(item.yearRange);
    setSelectedVariable(item.variable);
    setIsPlaying(false);
    setCodeMapOutput(null);
    setResearchMapOutput(null);
  }, [selectedAnalysisItems]);

  const handleRemoveAnalysisItem = useCallback((itemId) => {
    const nextItems = selectedAnalysisItems.filter((item) => item.id !== itemId);
    const removedActiveItem = selectedAnalysisItems[0]?.id === itemId;
    setSelectedAnalysisItems(nextItems);
    setAnalysisGraphEntries((prev) => {
      if (!prev[itemId]) return prev;
      const next = { ...prev };
      delete next[itemId];
      return next;
    });

    if (!removedActiveItem) return;
    const nextActiveItem = nextItems[0];
    setIsPlaying(false);
    setCodeMapOutput(null);
    setResearchMapOutput(null);
    if (!nextActiveItem) {
      setSelectedVariable('');
      setDates([]);
      setCurrentDate(null);
      setCurrentDateIndex(0);
      setMapData([]);
      setHotspotData([]);
      setHotspotSummary(null);
      return;
    }
    setDatasetId(nextActiveItem.datasetId);
    setSelectedYearRange(nextActiveItem.yearRange);
    setSelectedVariable(nextActiveItem.variable);
  }, [selectedAnalysisItems]);

  const handleVariableSelectionToggle = useCallback((variable, checked) => {
    if (variable === GLACIER_LAYER_VARIABLE) {
      setMapViewMode(checked ? 'glacier' : 'basin');
      return;
    }
    if (!datasetId || !activeYearRange || !variable) return;
    if (checked) {
      handlePrimaryVariableChange(variable);
      return;
    }
    handleRemoveAnalysisItem(buildAnalysisItemId(datasetId, activeYearRange, variable));
  }, [activeYearRange, datasetId, handlePrimaryVariableChange, handleRemoveAnalysisItem]);

  const handleVariableDatasetChange = useCallback((nextDatasetId) => {
    const nextDataset = datasets.find((item) => item.id === nextDatasetId);
    if (!nextDataset || !nextDataset.ready || nextDataset.id === datasetId) return;

    mapAbortRef.current?.abort?.();
    hotspotAbortRef.current?.abort?.();
    outcomeDataAbortRef.current?.abort?.();
    abortGraphRequests();
    setDatasetId(nextDataset.id);
    setSelectedYearRange({ start: null, end: null });
    setVariables([]);
    setSelectedVariable('');
    setComparisonVariables([]);
    setVariablesContextKey('');
    setMapData([]);
    setHotspotData([]);
    setHotspotSummary(null);
    setOutcomeData([]);
    setOutcomeStats(null);
    setCodeMapOutput(null);
    setResearchMapOutput(null);
    setAnalysisMode('daily');
    setIsPlaying(false);
    setError(null);
    setHotspotError('');
    setOutcomeDataError('');
  }, [abortGraphRequests, datasetId, datasets]);

  const handleHotspotMinYearsChange = useCallback((value) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed)) return;
    const clamped = Math.min(hotspotMinYearsMax, Math.max(2, parsed));
    setHotspotMinYears(clamped);
  }, [hotspotMinYearsMax]);

  const handleSubregionChange = useCallback((value) => {
    setSelectedSubregionId(value);
    setSelectedSubregionFeature(null);
    if (value) setPolygonDrawMode(false);
    const nextLabel = subregions.find((item) => item.id === value)?.label || '';
    setSubregionSearchText(nextLabel);
    setSubregionDropdownOpen(false);
  }, [subregions]);

  useEffect(() => {
    if (selectedSubregionId) {
      setSubregionSearchText(selectedSubregion?.label || '');
      return;
    }
    if (!subregionDropdownOpen) {
      setSubregionSearchText('');
    }
  }, [selectedSubregionId, selectedSubregion, subregionDropdownOpen]);

  const handleUpdateFocusLocation = useCallback((id, lat, lon) => {
    setFocusLocations((prev) => prev.map((loc) => loc.id === id ? { ...loc, lat, lon } : loc));
  }, []);

  const handleRemoveFocusLocation = useCallback((id) => {
    setFocusLocations((prev) => prev.filter((loc) => loc.id !== id));
  }, []);

  const handleTogglePolygonDraw = useCallback(() => {
    setPolygonDrawMode((prev) => !prev);
  }, []);

  const handleAoiComplete = useCallback((geometry) => {
    const created = {
      id: `polygon-${Date.now()}`,
      name: aoiPolygons.length === 0 ? 'ROI' : `Polygon ${aoiPolygons.length + 1}`,
      createdAt: Date.now(),
      geometry,
    };
    const draft = normalizeAoiPolygon(created, aoiPolygons.length);
    if (!draft) return;
    setAoiPolygons((prev) => normalizeAoiPolygons([...prev, draft]));
    setSelectedAoiId(draft.id);
    setPolygonDrawMode(false);
    setIsPlaying(false);
  }, [aoiPolygons.length]);

  const handleRenameAoi = useCallback((id, name) => {
    setAoiPolygons((prev) => normalizeAoiPolygons(prev.map((polygon) => {
      if (polygon.id !== id) return polygon;
      const next = { ...polygon, name };
      return { ...next, analysis: analyzeAoiGeometry(next) };
    })));
  }, []);

  const handleRemoveAoi = useCallback((id) => {
    setAoiPolygons((prev) => normalizeAoiPolygons(prev.filter((polygon) => polygon.id !== id)));
    setSelectedAoiId((current) => (current === id ? '' : current));
  }, []);

  // ── Shapefile loading handler ──────────────────────────────────────
  const handleShapefileLoad = useCallback(async (fileList) => {
    if (!fileList || fileList.length === 0) return;
    setShapefileLoading(true);
    try {
      const files = Array.from(fileList);
      let geojson = null;

      // Case 1: ZIP file (contains .shp + .dbf etc)
      const zipFile = files.find((f) => f.name.toLowerCase().endsWith('.zip'));
      if (zipFile) {
        const buffer = await zipFile.arrayBuffer();
        geojson = await shpjs(buffer);
      } else {
        // Case 2: GeoJSON file
        const jsonFile = files.find((f) => {
          const lower = f.name.toLowerCase();
          return lower.endsWith('.geojson') || lower.endsWith('.json');
        });
        if (jsonFile) {
          const text = await jsonFile.text();
          geojson = JSON.parse(text);
        } else {
          // Case 3: individual .shp file (with optional .dbf, .prj)
          const shpFile = files.find((f) => f.name.toLowerCase().endsWith('.shp'));
          const dbfFile = files.find((f) => f.name.toLowerCase().endsWith('.dbf'));
          if (shpFile) {
            const shpBuffer = await shpFile.arrayBuffer();
            const dbfBuffer = dbfFile ? await dbfFile.arrayBuffer() : undefined;
            const parsedShp = parseShp(shpBuffer);
            const parsedDbf = dbfBuffer ? parseDbf(dbfBuffer) : [];
            geojson = shpCombine([parsedShp, parsedDbf]);
          }
        }
      }

      if (!geojson) {
        alert('Could not parse the selected file(s). Please provide a .zip, .shp, or .geojson file.');
        return;
      }

      // Handle shpjs returning array of FeatureCollections (multi-layer zip)
      if (Array.isArray(geojson)) {
        geojson = {
          type: 'FeatureCollection',
          features: geojson.flatMap((fc) => fc?.features || []),
        };
      }

      const polygonFeatures = extractPolygonFeatures(geojson);
      if (polygonFeatures.length === 0) {
        alert('No polygon geometries found in the shapefile. Only Polygon and MultiPolygon features are supported.');
        return;
      }

      const sourceFileName = (zipFile || files.find((f) => f.name.toLowerCase().endsWith('.shp')) || files[0])?.name || 'shapefile';
      const timestamp = Date.now();
      const newPolygons = polygonFeatures.map((feature, idx) => {
        const props = feature.properties || {};
        const featureName = props.NAME || props.name || props.Name || props.LABEL || props.label || '';
        return {
          id: `shp-${timestamp}-${idx}`,
          name: featureName || `${sourceFileName.replace(/\.[^.]+$/, '')}${polygonFeatures.length > 1 ? ` #${idx + 1}` : ''}`,
          createdAt: timestamp,
          geometry: feature.geometry,
          metadata: {
            source: 'shapefile',
            sourceFile: sourceFileName,
            properties: props,
          },
        };
      });

      setAoiPolygons((prev) => {
        const merged = [...prev, ...newPolygons];
        return normalizeAoiPolygons(merged);
      });
      if (newPolygons.length > 0) {
        setSelectedAoiId(newPolygons[0].id);
      }
      setPolygonDrawMode(false);
      setIsPlaying(false);
    } catch (err) {
      console.error('Shapefile parse error:', err);
      alert(`Failed to load shapefile: ${err.message || 'Unknown error'}`);
    } finally {
      setShapefileLoading(false);
    }
  }, []);

  // ── Persist shapefile polygons to IndexedDB ────────────────────────
  useEffect(() => {
    if (!shapefileRestoredRef.current) return;
    const shapePolygons = aoiPolygons.filter(
      (p) => p.metadata?.source === 'shapefile'
    );
    shapefileDB.savePolygons(shapePolygons);
  }, [aoiPolygons]);

  // ── Restore shapefile polygons from IndexedDB on mount ────────────
  useEffect(() => {
    if (shapefileRestoredRef.current) return;
    shapefileRestoredRef.current = true;
    shapefileDB.loadPolygons().then((savedPolygons) => {
      if (savedPolygons.length === 0) return;
      setAoiPolygons((prev) => {
        // Avoid duplicates if already restored by project
        const existingIds = new Set(prev.map((p) => p.id));
        const toAdd = savedPolygons.filter((p) => !existingIds.has(p.id));
        if (toAdd.length === 0) return prev;
        return normalizeAoiPolygons([...prev, ...toAdd]);
      });
    });
  }, []);

  const handleYearStartChange = useCallback((value) => {
    const nextStart = Number.parseInt(value, 10);
    if (!Number.isInteger(nextStart)) return;
    if (yearOptions.length === 0) return;
    const minYear = yearOptions[0];
    const maxYear = yearOptions[yearOptions.length - 1];
    const clampedStart = Math.min(maxYear, Math.max(minYear, nextStart));
    setSelectedYearRange((prev) => {
      const currentEndRaw = Number.isInteger(prev.end) ? prev.end : clampedStart;
      const currentEnd = Math.min(maxYear, Math.max(minYear, currentEndRaw));
      return {
        start: Math.min(clampedStart, currentEnd),
        end: Math.max(clampedStart, currentEnd),
      };
    });
  }, [yearOptions]);

  const handleYearEndChange = useCallback((value) => {
    const nextEnd = Number.parseInt(value, 10);
    if (!Number.isInteger(nextEnd)) return;
    if (yearOptions.length === 0) return;
    const minYear = yearOptions[0];
    const maxYear = yearOptions[yearOptions.length - 1];
    const clampedEnd = Math.min(maxYear, Math.max(minYear, nextEnd));
    setSelectedYearRange((prev) => {
      const currentStartRaw = Number.isInteger(prev.start) ? prev.start : clampedEnd;
      const currentStart = Math.min(maxYear, Math.max(minYear, currentStartRaw));
      return {
        start: Math.min(currentStart, clampedEnd),
        end: Math.max(currentStart, clampedEnd),
      };
    });
  }, [yearOptions]);

  const handleNcUpload = useCallback(async () => {
    if (!ncFile) {
      setNcUploadError('Select a .nc file first.');
      return;
    }

    setNcUploading(true);
    setNcUploadError('');
    setNcUploadMessage('');
    try {
      const result = await apiService.uploadNcDataset(ncFile, ncDatasetName);
      const datasetsResponse = await apiService.getDatasets();
      const list = datasetsResponse.datasets || [];
      setDatasets(list);

      const newDatasetId = result.dataset_id;
      const preferred = list.find((d) => d.id === newDatasetId && d.ready);
      const fallback = list.find((d) => d.ready) || list[0];
      const nextId = (preferred || fallback)?.id || '';
      setDatasetId(nextId);

      setNcUploadMessage(
        `Upload complete: ${result.dataset_label} (${(result.conversion?.parquet_files || []).length} parquet files)`
      );
      setNcFile(null);
      setNcDatasetName('');
    } catch (err) {
      const message = err?.response?.data?.detail || err?.message || 'NC upload failed.';
      setNcUploadError(message);
    } finally {
      setNcUploading(false);
    }
  }, [ncFile, ncDatasetName]);

  const applyProjectPayload = useCallback((payload) => {
    const project = payload?.project;
    const workspace = payload?.workspace || {};
    const dashboard = workspace.dashboard || {};
    const layout = workspace.layout || {};
    const tools = workspace.tools || {};
    if (!project?.id) throw new Error('The project file is missing its identity metadata.');
    const restoredAnalysisItems = normalizeAnalysisItems(dashboard.analysisItems, dashboard);

    if (projectRestoreTimerRef.current) window.clearTimeout(projectRestoreTimerRef.current);
    projectBaselineRef.current = '';
    pendingProjectRestoreRef.current = payload;
    projectRestoreSnapshotRef.current = payload;
    setActiveProject(project);
    const restoredCodeState = { ...(tools.code || {}), code: payload.code || tools.code?.code || '' };
    setProjectToolState({
      code: restoredCodeState,
      research: tools.research || {},
    });
    codeWorkspaceLiveRef.current = restoredCodeState;
    if (dashboard.datasetId) setDatasetId(dashboard.datasetId);
    if (dashboard.selectedOutcomeId) setSelectedOutcomeId(dashboard.selectedOutcomeId);
    if (dashboard.selectedYearRange) setSelectedYearRange(dashboard.selectedYearRange);
    setCurrentDate(dashboard.currentDate || null);
    setCurrentDateIndex(0);
    setDates([]);
    setSelectedVariable(dashboard.selectedVariable || '');
    setSelectedAnalysisItems(restoredAnalysisItems);
    setAnalysisGraphEntries({});
    setComparisonVariables(dashboard.comparisonVariables || []);
    setSelectedSubregionId(dashboard.selectedSubregionId || '');
    const restoredAois = normalizeAoiPolygons(dashboard.aoiPolygons);
    setAoiPolygons(restoredAois);
    setSelectedAoiId(restoredAois.some((polygon) => polygon.id === dashboard.selectedAoiId) ? dashboard.selectedAoiId : '');
    setPolygonDrawMode(false);
    setFocusLocations(dashboard.focusLocations || []);
    setSelectedElevRange(dashboard.selectedElevRange || { min: 500, max: 9000 });
    setMapViewMode(dashboard.mapViewMode || 'basin');
    setAnalysisMode(dashboard.analysisMode || 'daily');
    setHotspotMinYears(Number(dashboard.hotspotMinYears) || 3);
    setOutcomeVariable(dashboard.outcomeVariable || '');
    setOutcomeBandId(dashboard.outcomeBandId || '');
    setOutcomeViewMode(dashboard.outcomeViewMode || 'mean');
    setOutcomeComparisonId(dashboard.outcomeComparisonId || '');
    if (layout.theme === 'light' || layout.theme === 'dark') setTheme(layout.theme);
    setBottomPanelHeight(clamp(Number(layout.bottomPanelHeight) || 360, 180, 520));
    setCodePanelWidth(clamp(Number(layout.codePanelWidth) || 620, 360, 760));
    setCodePanelOpen(Boolean(layout.codePanelOpen));
    setResearchPanelOpen(!layout.codePanelOpen && Boolean(layout.researchPanelOpen));
    setShowDocumentation(workspace.view === 'documentation');
    setDatasetReady(true);
    setError(null);
    setProjectsError('');
    setProjectDirty(false);
    setProjectSaveState('idle');
    recordNavigation({ view: workspace.view === 'outcome' ? 'outcome' : 'dashboard' });

    projectRestoreTimerRef.current = window.setTimeout(() => {
      projectBaselineRef.current = latestProjectFingerprintRef.current;
      setProjectDirty(false);
    }, 1800);
  }, [recordNavigation]);

  const handleCreateProject = useCallback(async ({ name, description }) => {
    if (activeProject && projectDirty && !window.confirm('The current project has unsaved changes. Create a new project without saving them?')) return false;
    setProjectsError('');
    try {
      const projectYearRange = fullDatasetYearRange || activeYearRange || selectedYearRange;
      const freshWorkspace = {
        ...projectWorkspaceSnapshot,
        view: 'dashboard',
        dashboard: {
          ...projectWorkspaceSnapshot.dashboard,
          selectedYearRange: projectYearRange,
          currentDate: null,
          selectedVariable: '',
          comparisonVariables: [],
          analysisItems: [],
          deferVariableSelection: true,
          selectedSubregionId: '',
          aoiPolygons: [],
          selectedAoiId: '',
          analysisMode: 'daily',
          mapViewMode: 'basin',
        },
        layout: {
          ...projectWorkspaceSnapshot.layout,
          codePanelOpen: false,
          researchPanelOpen: false,
        },
        tools: { code: {}, research: {} },
      };
      const payload = await apiService.createProject({
        name,
        description,
        workspace: freshWorkspace,
        code: '',
      });
      setProjects((current) => [payload.project, ...current.filter((item) => item.id !== payload.project.id)]);
      applyProjectPayload(payload);
      return true;
    } catch (projectError) {
      setProjectsError(projectError?.response?.data?.detail || projectError?.message || 'Could not create the project.');
      return false;
    }
  }, [activeProject, activeYearRange, applyProjectPayload, fullDatasetYearRange, projectDirty, projectWorkspaceSnapshot, selectedYearRange]);

  const handleOpenProject = useCallback(async (projectId) => {
    if (activeProject?.id !== projectId && projectDirty && !window.confirm('The current project has unsaved changes. Open another project without saving them?')) return;
    setProjectsError('');
    try {
      const payload = await apiService.getProject(projectId);
      applyProjectPayload(payload);
      setProjects((current) => current.map((item) => item.id === projectId ? payload.project : item));
    } catch (projectError) {
      setProjectsError(projectError?.response?.data?.detail || projectError?.message || 'Could not open the project.');
    }
  }, [activeProject?.id, applyProjectPayload, projectDirty]);

  const handleSaveProject = useCallback(async () => {
    if (!activeProject || projectSaveState === 'saving') return;
    setProjectSaveState('saving');
    const liveCodeState = codeWorkspaceLiveRef.current || projectToolState.code || {};
    const codeStateForStorage = getCodeStateForProjectStorage(liveCodeState);
    const workspaceToSave = {
      ...projectWorkspaceSnapshot,
      tools: {
        ...projectWorkspaceSnapshot.tools,
        code: codeStateForStorage,
      },
    };
    const savedFingerprint = buildProjectFingerprint(workspaceToSave, liveCodeState.code || '');
    try {
      const payload = await apiService.saveProject(
        activeProject.id,
        workspaceToSave,
        liveCodeState.code || ''
      );
      setActiveProject(payload.project);
      setProjects((current) => [payload.project, ...current.filter((item) => item.id !== payload.project.id)]);
      projectBaselineRef.current = savedFingerprint;
      setProjectDirty(false);
      setProjectSaveState('saved');
      window.setTimeout(() => setProjectSaveState('idle'), 1400);
    } catch (projectError) {
      console.error('Project save failed:', projectError);
      setProjectSaveState('error');
    }
  }, [activeProject, projectSaveState, projectToolState.code?.code, projectWorkspaceFingerprint, projectWorkspaceSnapshot]);

  const handleArchiveProject = useCallback(async (projectId) => {
    if (activeProject?.id === projectId && projectDirty && !window.confirm('This project has unsaved changes. Archive its last saved version?')) return;
    setProjectsError('');
    try {
      await apiService.archiveProject(projectId);
      setProjects((current) => current.filter((item) => item.id !== projectId));
      if (activeProject?.id === projectId) {
        setActiveProject(null);
        projectBaselineRef.current = '';
        setProjectDirty(false);
      }
    } catch (projectError) {
      setProjectsError(projectError?.response?.data?.detail || projectError?.message || 'Could not archive the project.');
    }
  }, [activeProject?.id, projectDirty]);

  const handleDeleteProject = useCallback(async (projectId) => {
    setProjectsError('');
    try {
      await apiService.deleteProject(projectId);
      setProjects((current) => current.filter((item) => item.id !== projectId));
      if (activeProject?.id === projectId) {
        setActiveProject(null);
        projectBaselineRef.current = '';
        setProjectDirty(false);
      }
    } catch (projectError) {
      setProjectsError(projectError?.response?.data?.detail || projectError?.message || 'Could not delete the project.');
    }
  }, [activeProject?.id]);

  useEffect(() => {
    const handleSaveShortcut = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
      if (!activeProject) return;
      event.preventDefault();
      handleSaveProject();
    };
    window.addEventListener('keydown', handleSaveShortcut);
    return () => window.removeEventListener('keydown', handleSaveShortcut);
  }, [activeProject, handleSaveProject]);

  const handleStartDataset = useCallback(() => {
    if (!datasetId) {
      setError('Please select a dataset first.');
      return;
    }
    if (!activeYearRange) {
      setError('Please choose a valid year range first.');
      return;
    }
    apiService.clearCache();
    mapAbortRef.current?.abort?.();
    hotspotAbortRef.current?.abort?.();
    outcomeDataAbortRef.current?.abort?.();
    abortGraphRequests();
    subregionGeometryAbortRef.current?.abort?.();
    setSelectedAnalysisItems([]);
    setAnalysisGraphEntries({});
    setMapData([]);
    setHotspotData([]);
    setHotspotSummary(null);
    setHotspotLoading(false);
    setHotspotError('');
    setHotspotMinYears(3);
    setPolygonDrawMode(false);
    setOutcomeData([]);
    setOutcomeStats(null);
    setOutcomeDataLoading(false);
    setOutcomeDataError('');
    setAnalysisMode('daily');
    setMapViewMode('basin');
    setError(null);
    setShowDocumentation(false);
    setCodePanelOpen(false);
    setCodeMapOutput(null);
    setResearchPanelOpen(false);
    setResearchMapOutput(null);
    setDatasetReady(true);
    recordNavigation({ view: 'dashboard' });
  }, [abortGraphRequests, datasetId, activeYearRange, recordNavigation]);

  const handleStartOutcome = useCallback(() => {
    const selectedOutcome = outcomes.find((item) => item.id === selectedOutcomeId);
    if (!selectedOutcome || !selectedOutcome.ready) {
      setError('Selected outcome is not ready. Generate outcome outputs first.');
      return;
    }

    apiService.clearCache();
    mapAbortRef.current?.abort?.();
    hotspotAbortRef.current?.abort?.();
    outcomeDataAbortRef.current?.abort?.();
    abortGraphRequests();
    subregionGeometryAbortRef.current?.abort?.();
    setIsPlaying(false);
    setShowDocumentation(false);
    setError(null);
    setLoading(false);
    setMapViewMode('basin');
    if (selectedOutcome.dataset && datasets.some((item) => item.id === selectedOutcome.dataset)) {
      setDatasetId(selectedOutcome.dataset);
    }
    setCodePanelOpen(false);
    setCodeMapOutput(null);
    setResearchPanelOpen(false);
    setResearchMapOutput(null);
    setOutcomeData([]);
    setOutcomeStats(null);
    setOutcomeDataError('');
    setOutcomeDataLoading(false);
    setAnalysisMode('outcome');
    setDatasetReady(true);
    recordNavigation({ view: 'dashboard' });
  }, [abortGraphRequests, datasets, outcomes, selectedOutcomeId, recordNavigation]);

  const handleGoHome = useCallback(() => {
    setIsPlaying(false);
    setRegionSelectMode(false);
    setRegionPreview(null);
    setAnalysisMode('daily');
    setOutcomeData([]);
    setOutcomeStats(null);
    setOutcomeDataError('');
    outcomeDataAbortRef.current?.abort?.();
    setCodePanelOpen(false);
    setCodeMapOutput(null);
    setResearchPanelOpen(false);
    setResearchMapOutput(null);
    setError(null);
    setShowDocumentation(false);
    setDatasetReady(false);
    recordNavigation({ view: 'home' });
  }, [recordNavigation]);

  const handleToggleDocumentation = useCallback(() => {
    if (showDocumentation) {
      handleNavigateBack();
      return;
    }

    const baseView = datasetReady ? 'dashboard' : 'home';
    setShowDocumentation(true);
    setCodePanelOpen(false);
    setCodeMapOutput(null);
    setResearchPanelOpen(false);
    setResearchMapOutput(null);
    recordNavigation({ view: 'documentation', baseView });
  }, [datasetReady, handleNavigateBack, recordNavigation, showDocumentation]);

  const handleToggleCodePanel = useCallback(() => {
    setShowDocumentation(false);
    setSearchToolsOpen(false);
    setActiveToolPanel('');
    setIsPlaying(false);
    setResearchPanelOpen(false);
    setResearchMapOutput(null);
    setCodePanelOpen((prev) => {
      if (prev) {
        setCodeMapOutput(null);
      }
      return !prev;
    });
  }, []);

  const handleCloseCodePanel = useCallback(() => {
    setCodePanelOpen(false);
    setCodeMapOutput(null);
  }, []);

  const handleCodeMapOutputChange = useCallback((output) => {
    setCodeMapOutput(output);
  }, []);

  const handleToggleResearchPanel = useCallback(() => {
    setShowDocumentation(false);
    setSearchToolsOpen(false);
    setActiveToolPanel('');
    setIsPlaying(false);
    setCodePanelOpen(false);
    setCodeMapOutput(null);
    setResearchPanelOpen((prev) => {
      if (prev) setResearchMapOutput(null);
      return !prev;
    });
  }, []);

  const handleCloseResearchPanel = useCallback(() => {
    setResearchPanelOpen(false);
    setResearchMapOutput(null);
  }, []);

  const handleResearchMapOutputChange = useCallback((output) => {
    setResearchMapOutput(output);
  }, []);

  const handleHomeModuleChange = useCallback((moduleName) => {
    const nextModule = ['projects', 'outcomes'].includes(moduleName) ? moduleName : 'dashboard';
    setHomeModule(nextModule);
    setError(null);
    if (nextModule !== 'dashboard') {
      setShowDocumentation(false);
    }
  }, []);

  const yearMin = yearOptions.length > 0 ? yearOptions[0] : null;
  const yearMax = yearOptions.length > 0 ? yearOptions[yearOptions.length - 1] : null;
  const regionContextLabel = roiPolygon?.name || selectedSubregion?.label || 'Full basin';
  const analysisContextLabel = hasToolMapOutput
    ? 'Derived result'
    : isOutcomeMode
      ? 'Saved outcome'
      : isHotspotMode
        ? 'Trend hotspots'
        : 'Daily map';




  const renderQuickRegionResults = () => {
    const hasResults = filteredBasinSubregions.length > 0 || filteredGlacierSubregions.length > 0;
    const coordinateMatch = parseCoordinates(subregionSearchText);
    return (
      <div className="quick-region-results">
        <div className="quick-region-header">
          <strong>Regions & Glaciers</strong>
          <span>{subregionSearchText.trim() ? 'Filtered results' : 'Start typing to filter'}</span>
        </div>
        <div className="quick-region-list">
          {coordinateMatch && (
            <button
              type="button"
              className="quick-region-item coordinate-item"
              onClick={() => {
                const newId = Date.now().toString();
                setFocusLocations((prev) => [...prev, { lat: coordinateMatch.lat, lon: coordinateMatch.lon, id: newId }]);
                setSearchToolsOpen(false);
                setSubregionSearchText('');
              }}
            >
              <span>Coordinate Pin: {coordinateMatch.lat.toFixed(4)}, {coordinateMatch.lon.toFixed(4)}</span>
              <small>Click to add marker</small>
            </button>
          )}
          {hasResults ? (
            <>
              {filteredBasinSubregions.map((region) => (
                <button
                  key={region.id}
                  type="button"
                  className={`quick-region-item ${selectedSubregionId === region.id ? 'selected' : ''}`}
                  onClick={() => {
                    handleSubregionChange(region.id);
                    setMapViewMode('basin');
                    setSearchToolsOpen(false);
                  }}
                >
                  <span>{region.label}</span>
                  <small>Basin | ID: {region.id}</small>
                </button>
              ))}
              {filteredGlacierSubregions.map((region) => (
                <button
                  key={region.id}
                  type="button"
                  className={`quick-region-item ${selectedSubregionId === region.id ? 'selected' : ''}`}
                  onClick={() => {
                    handleSubregionChange(region.id);
                    setMapViewMode('glacier');
                    setSearchToolsOpen(false);
                  }}
                >
                  <span>{region.label}</span>
                  <small>Glacier | ID: {region.id}</small>
                </button>
              ))}
            </>
          ) : (
            <div className="quick-region-empty">No region or glacier matches found.</div>
          )}
        </div>
      </div>
    );
  };

  const renderRegionSelectionPanel = (className = 'region-panel', showSubregionPicker = true) => (
    <div className={className}>
      <h3>Basin Search</h3>
      {showSubregionPicker && <div className="subregion-picker">
        <label htmlFor="subregion-select">Basin or Glacier</label>
        <div className="subregion-combobox">
          <input
            id="subregion-select"
            type="text"
            value={subregionSearchText}
            onChange={(e) => {
              setSubregionSearchText(e.target.value);
              setSubregionDropdownOpen(true);
              if (selectedSubregionId) {
                setSelectedSubregionId('');
                setSelectedSubregionFeature(null);
              }
            }}
            onFocus={() => setSubregionDropdownOpen(true)}
            onBlur={() => {
              window.setTimeout(() => setSubregionDropdownOpen(false), 120);
            }}
            placeholder="Type to search basins or glaciers"
            disabled={subregionsLoading}
            autoComplete="off"
          />
          {subregionDropdownOpen && !subregionsLoading && (
            <div className="subregion-dropdown" role="listbox" aria-label="Sub-region suggestions">
              {(filteredBasinSubregions.length > 0 || filteredGlacierSubregions.length > 0) ? (
                <>
                  {filteredBasinSubregions.length > 0 && (
                    <div className="subregion-group">
                      <div className="subregion-group-label">
                        Basin Sub-Regions ({filteredBasinSubregions.length})
                      </div>
                      {filteredBasinSubregions.map((region) => (
                        <button
                          key={region.id}
                          type="button"
                          className={`subregion-option ${selectedSubregionId === region.id ? 'selected' : ''}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => handleSubregionChange(region.id)}
                        >
                          <span className="subregion-option-label">{region.label}</span>
                          <span className="subregion-option-meta">Basin | ID: {region.id}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {filteredGlacierSubregions.length > 0 && (
                    <div className="subregion-group">
                      <div className="subregion-group-label">
                        Glacier Results ({filteredGlacierSubregions.length})
                      </div>
                      {filteredGlacierSubregions.map((region) => (
                        <button
                          key={region.id}
                          type="button"
                          className={`subregion-option ${selectedSubregionId === region.id ? 'selected' : ''}`}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => handleSubregionChange(region.id)}
                        >
                          <span className="subregion-option-label">{region.label}</span>
                          <span className="subregion-option-meta">Glacier | ID: {region.id}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="subregion-empty">No matches found.</div>
              )}
            </div>
          )}
        </div>
        {subregionsLoading && (
          <div className="subregion-loading">Loading sub-regions...</div>
        )}
      </div>}
      <div className="region-panel-note">
        {showSubregionPicker
          ? 'Choose a basin or glacier. Use the Polygon tool on the map for the ROI and other polygons.'
          : 'Search for a basin or glacier above, or draw a polygon on the map.'}
      </div>
      {selectedSubregion && (
        <div className="region-details">
          <div className="region-row">
            Selected: {selectedSubregion.label}
            {selectedSubregion.kind === 'glacier' ? '' : ` (ID: ${selectedSubregion.id})`}
          </div>
        </div>
      )}
      {!selectedSubregion && (
        <div className="region-hint">Pick a basin/glacier here, or draw a polygon directly on the map.</div>
      )}
    </div>
  );

  const renderVariablePanel = (className = 'variable-panel') => (
    <div className={className}>
      <h3>Variable Selection</h3>
      <div className="variable-dataset-picker">
        <label htmlFor="dashboard-variable-dataset">Dataset</label>
        <select
          id="dashboard-variable-dataset"
          value={datasetId}
          onChange={(event) => handleVariableDatasetChange(event.target.value)}
        >
          {datasets.map((dataset) => (
            <option key={dataset.id} value={dataset.id} disabled={!dataset.ready}>
              {dataset.label}{dataset.ready ? '' : ' (missing)'}
            </option>
          ))}
        </select>
      </div>
      <div className="variable-options">
        <label className={`variable-option ${glacierViewEnabled ? 'active' : ''}`} key={GLACIER_LAYER_VARIABLE}>
          <input
            type="checkbox"
            checked={glacierViewEnabled}
            onChange={(event) => handleVariableSelectionToggle(GLACIER_LAYER_VARIABLE, event.target.checked)}
          />
          <span>Glaciers</span>
          {glacierViewEnabled && <em>Overlay</em>}
        </label>
        {variables.map((variable) => {
          const analysisId = buildAnalysisItemId(datasetId, activeYearRange, variable);
          const isSelected = selectedAnalysisIdSet.has(analysisId);
          const isActive = selectedVariable === variable && activeAnalysisItem?.id === analysisId;
          return (
            <label className={`variable-option ${isActive ? 'active' : ''}`} key={variable}>
              <input
                type="checkbox"
                checked={isSelected}
                onChange={(event) => handleVariableSelectionToggle(variable, event.target.checked)}
                disabled={!activeYearRange}
              />
              <span>{formatVariableLabel(variable)}</span>
              {isActive && <em>Map</em>}
            </label>
          );
        })}
      </div>
      {variables.length === 0 && (
        <div className="variable-empty">No dataset variables available</div>
      )}
      {selectedAnalysisItems.length > 0 && (
        <div className="selected-analysis-note">
          {selectedAnalysisItems.length} selected layer{selectedAnalysisItems.length === 1 ? '' : 's'}
        </div>
      )}
    </div>
  );

  const renderHotspotPanel = (className = 'hotspot-panel') => (
    <div className={className}>
      <h3>Analysis Mode</h3>
      <p>Switch between daily fields, live trend fitting, and saved outcome layers.</p>
      <div className="hotspot-mode-switch analysis-mode-switch">
        <button
          type="button"
          className={`hotspot-mode-btn ${analysisMode === 'daily' ? 'active' : ''}`}
          onClick={() => handleAnalysisModeChange('daily')}
        >
          Daily Map
        </button>
        <button
          type="button"
          className={`hotspot-mode-btn ${isHotspotMode ? 'active' : ''}`}
          onClick={() => handleAnalysisModeChange('hotspot')}
        >
          Trend Hotspots
        </button>
        <button
          type="button"
          className={`hotspot-mode-btn ${isOutcomeMode ? 'active' : ''}`}
          onClick={() => handleAnalysisModeChange('outcome')}
          disabled={!selectedOutcome?.ready}
          title={!selectedOutcome?.ready ? 'Generate outcome outputs first' : 'Show saved analyzed output on the dashboard'}
        >
          Saved Outcome
        </button>
      </div>
      {isHotspotMode && (
        <>
          <div className="hotspot-control">
            <label htmlFor="hotspot-min-years">
              Minimum yearly coverage: <strong>{hotspotMinYears}</strong>
            </label>
            <input
              id="hotspot-min-years"
              type="range"
              min="2"
              max={hotspotMinYearsMax}
              step="1"
              value={hotspotMinYears}
              onChange={(e) => handleHotspotMinYearsChange(e.target.value)}
            />
            <div className="hotspot-note">
              Uses years with at least {hotspotMinYears} annual observations per grid point.
            </div>
          </div>
          {hotspotLoading && (
            <div className="hotspot-loading">Computing hotspot trends...</div>
          )}
          {hotspotError && (
            <div className="hotspot-error">{hotspotError}</div>
          )}
          {!hotspotLoading && !hotspotError && hotspotSummary && (
            <div className="hotspot-summary">
              <div className="hotspot-summary-row">
                <span>Points analyzed</span>
                <strong>{Number(hotspotSummary.points_analyzed || 0).toLocaleString()}</strong>
              </div>
              <div className="hotspot-summary-row">
                <span>High / extreme hotspots</span>
                <strong>{Number(hotspotSummary.hotspots_identified || 0).toLocaleString()}</strong>
              </div>
              <div className="hotspot-summary-row">
                <span>Mean trend strength</span>
                <strong>{Number.isFinite(hotspotSummary.mean_strength) ? hotspotSummary.mean_strength.toFixed(4) : 'N/A'}</strong>
              </div>
              <div className="hotspot-summary-row">
                <span>Max trend strength</span>
                <strong>{Number.isFinite(hotspotSummary.max_strength) ? hotspotSummary.max_strength.toFixed(4) : 'N/A'}</strong>
              </div>
              <div className="hotspot-summary-row">
                <span>Strength P95</span>
                <strong>
                  {Number.isFinite(hotspotSummary?.strength_percentiles?.p95)
                    ? hotspotSummary.strength_percentiles.p95.toFixed(4)
                    : 'N/A'}
                </strong>
              </div>
            </div>
          )}
        </>
      )}
      {isOutcomeMode && renderOutcomeControls('outcome-panel embedded-outcome-panel')}
      {!isHotspotMode && !isOutcomeMode && (
        <div className="hotspot-hint">
          Daily map mode shows date-wise values. Switch to hotspot mode for long-term trend intensity.
        </div>
      )}
    </div>
  );

  const renderOutcomeControls = (className = 'outcome-panel') => (
    <div className={className}>
      <h3>Saved Outcome</h3>
      {outcomeMetaLoading && <div className="outcome-loading-text">Loading outcome metadata...</div>}
      {outcomeMetaError && <div className="outcome-error-text">{outcomeMetaError}</div>}
      {!outcomeMetaLoading && !outcomeMetaError && outcomeMeta && (
        <>
          <div className="outcome-name">{outcomeMeta.label || selectedOutcome?.label || 'Long Term Hotspot Analysis'}</div>
          <p>{outcomeMeta.description || selectedOutcome?.description || 'Precomputed spatial analysis output.'}</p>
          <div className="outcome-mode-switch">
            <button
              type="button"
              className={`outcome-mode-btn ${outcomeViewMode === 'mean' ? 'active' : ''}`}
              onClick={() => setOutcomeViewMode('mean')}
            >
              Band Value
            </button>
            <button
              type="button"
              className={`outcome-mode-btn ${outcomeViewMode === 'difference' ? 'active' : ''}`}
              onClick={() => setOutcomeViewMode('difference')}
              disabled={!outcomeComparisonId}
              title={!outcomeComparisonId ? 'Generate band difference outputs first' : 'Show later minus earlier change'}
            >
              Change
            </button>
          </div>

          <div className="outcome-selector-group">
            <label>Variable</label>
            <div className="outcome-band-options">
              {(outcomeMeta.variables || []).map((variable) => (
                <label className="outcome-band-option" key={`outcome-variable-${variable}`}>
                  <input
                    type="radio"
                    name="outcome-variable"
                    checked={outcomeVariable === variable}
                    onChange={() => setOutcomeVariable(variable)}
                  />
                  <span>{formatVariableLabel(variable)}</span>
                </label>
              ))}
            </div>
          </div>

          {outcomeViewMode === 'mean' && (
            <div className="outcome-selector-group">
              <label>Base Band</label>
              <div className="outcome-band-options">
                {(outcomeMeta.bands || []).map((band) => (
                  <label className="outcome-band-option" key={`outcome-band-${band.id}`}>
                    <input
                      type="radio"
                      name="outcome-band"
                      checked={String(outcomeBandId) === String(band.id)}
                      disabled={!outcomeAvailableBandIds.has(String(band.id))}
                      onChange={() => setOutcomeBandId(String(band.id))}
                    />
                    <span>{band.label}{!outcomeAvailableBandIds.has(String(band.id)) ? ' (unavailable)' : ''}</span>
                  </label>
                ))}
              </div>
              {(outcomeCoverage?.missing_years || []).length > 0 && (
                <p>Missing source year(s): {outcomeCoverage.missing_years.join(', ')}. Values use available samples only.</p>
              )}
            </div>
          )}

          {outcomeViewMode === 'difference' && (
            <div className="outcome-selector-group">
              <label>Change Pair</label>
              <div className="outcome-band-options">
                {(outcomeMeta.comparisons || []).map((comparison) => {
                  const disabled = !outcomeAvailableBandIds.has(String(comparison.earlier_band_id))
                    || !outcomeAvailableBandIds.has(String(comparison.later_band_id));
                  return (
                    <label className="outcome-band-option" key={`outcome-comparison-${comparison.id}`}>
                      <input
                        type="radio"
                        name="outcome-comparison"
                        checked={String(outcomeComparisonId) === String(comparison.id)}
                        disabled={disabled}
                        onChange={() => setOutcomeComparisonId(String(comparison.id))}
                      />
                      <span>{comparison.label}{disabled ? ' (unavailable)' : ''}</span>
                    </label>
                  );
                })}
                {(outcomeMeta.comparisons || []).length === 0 && (
                  <div className="outcome-empty-text">No saved difference layers found. Run python compute_band_differences.py.</div>
                )}
              </div>
            </div>
          )}

          <div className="hotspot-summary">
            <div className="hotspot-summary-row">
              <span>Total rows</span>
              <strong>{Number(outcomeMeta.row_count || 0).toLocaleString()}</strong>
            </div>
            <div className="hotspot-summary-row">
              <span>Unique points</span>
              <strong>{Number(outcomeMeta.point_count || 0).toLocaleString()}</strong>
            </div>
            <div className="hotspot-summary-row">
              <span>Map points</span>
              <strong>{outcomeData.length.toLocaleString()}</strong>
            </div>
          </div>
          {outcomeDataLoading && <div className="outcome-loading-text">Loading saved outcome map...</div>}
          {outcomeDataError && <div className="outcome-error-text">{outcomeDataError}</div>}
        </>
      )}
      {!outcomeMetaLoading && !outcomeMetaError && !outcomeMeta && (
        <div className="outcome-empty-text">Select a ready outcome module from the setup screen.</div>
      )}
    </div>
  );

  const renderLiveSummaryPanel = (className = 'info-panel') => (
    <div className={className}>
      <h3>Live Summary</h3>
      <div className="info-item">
        <span className="label">Date:</span>
        <span className="value">{formatDisplayDate(currentDate)}</span>
      </div>
      <div className="info-item">
        <span className="label">Variable:</span>
        <span className="value">{variableLabel}</span>
      </div>
      {selectedSubregion && (
        <div className="info-item">
          <span className="label">Sub-Region:</span>
          <span className="value">
            {selectedSubregion.label}
            {selectedSubregion.kind === 'glacier' ? '' : ` (ID: ${selectedSubregion.id})`}
          </span>
        </div>
      )}
      {roiPolygon && (
        <>
          <div className="info-item">
            <span className="label">ROI:</span>
            <span className="value">{roiPolygon.name}</span>
          </div>
          <div className="info-item">
            <span className="label">ROI Area:</span>
            <span className="value">{roiPolygon.analysis.areaKm2.toFixed(2)} km²</span>
          </div>
          <div className="info-item">
            <span className="label">ROI Vertices:</span>
            <span className="value">{roiPolygon.analysis.vertexCount}</span>
          </div>
        </>
      )}
      {activeYearRange && (
        <div className="info-item">
          <span className="label">Year Range:</span>
          <span className="value">
            {activeYearRange.start} - {activeYearRange.end}
          </span>
        </div>
      )}
      <div className="info-item">
        <span className="label">Elevation:</span>
        <span className="value">
          {selectedElevRange.min}m - {selectedElevRange.max}m
        </span>
      </div>
      <div className="info-item">
        <span className="label">{isHotspotMode ? 'Trend Points:' : 'Data Points:'}</span>
        <span className="value">{mapPointCount.toLocaleString()}</span>
      </div>
    </div>
  );

  const renderOutcomeSummaryPanel = () => (
    <div className="outcome-dashboard-summary">
      <div className="outcome-summary-header">
        <div>
          <h3>{outcomeMeta?.label || selectedOutcome?.label || 'Saved Outcome'}</h3>
          <p>{outcomeMapTitle}</p>
        </div>
        <button
          type="button"
          className="comparison-clear"
          onClick={() => setActiveToolPanel('hotspot')}
        >
          Edit outcome
        </button>
      </div>
      <div className="outcome-summary-grid">
        <div className="outcome-summary-card">
          <span>Variable</span>
          <strong>{outcomeVariableLabel || 'Select'}</strong>
        </div>
        <div className="outcome-summary-card">
          <span>Aggregation</span>
          <strong>{outcomeAggregationLabel}</strong>
        </div>
        <div className="outcome-summary-card">
          <span>{isOutcomeDifferenceMode ? 'Comparison' : 'Band'}</span>
          <strong>{isOutcomeDifferenceMode ? (outcomeComparison?.label || 'N/A') : (outcomeBand?.label || 'N/A')}</strong>
        </div>
        <div className="outcome-summary-card">
          <span>Map Points</span>
          <strong>{outcomeData.length.toLocaleString()}</strong>
        </div>
        {outcomeStats && (
          <>
            <div className="outcome-summary-card">
              <span>{isOutcomeDifferenceMode ? 'Min Change' : `Min ${outcomeAggregationLabel}`}</span>
              <strong>
                {Number.isFinite(isOutcomeDifferenceMode ? outcomeStats.min_change : outcomeStats.min)
                  ? (isOutcomeDifferenceMode ? outcomeStats.min_change : outcomeStats.min).toFixed(3)
                  : 'N/A'}
              </strong>
            </div>
            <div className="outcome-summary-card">
              <span>{isOutcomeDifferenceMode ? 'Max Change' : `Max ${outcomeAggregationLabel}`}</span>
              <strong>
                {Number.isFinite(isOutcomeDifferenceMode ? outcomeStats.max_change : outcomeStats.max)
                  ? (isOutcomeDifferenceMode ? outcomeStats.max_change : outcomeStats.max).toFixed(3)
                  : 'N/A'}
              </strong>
            </div>
            <div className="outcome-summary-card">
              <span>{isOutcomeDifferenceMode ? 'Mean Change' : 'Basin Mean'}</span>
              <strong>
                {Number.isFinite(isOutcomeDifferenceMode ? outcomeStats.mean_change : outcomeStats.mean)
                  ? (isOutcomeDifferenceMode ? outcomeStats.mean_change : outcomeStats.mean).toFixed(3)
                  : 'N/A'}
              </strong>
            </div>
          </>
        )}
      </div>
      {outcomeDataLoading && <div className="outcome-loading-text">Loading saved outcome map...</div>}
      {outcomeDataError && <div className="outcome-error-text">{outcomeDataError}</div>}
      <div className="outcome-footnote">
        Source: saved parquet outputs in {outcomeMeta?.output_directory || 'Outcomes/Long_term_hotspot/Outputs'}.
        Difference layers are later band value minus earlier band value.
      </div>
    </div>
  );

  const renderElevationPanel = (className = 'strip-elevation-panel') => (
    <div className={className}>
      <ElevationFilter
        min={elevationRange.min}
        max={elevationRange.max}
        selectedMin={selectedElevRange.min}
        selectedMax={selectedElevRange.max}
        onChange={handleElevationChange}
      />
    </div>
  );

  if (datasetLoading) {
    return (
      <div className="loading-screen">
        <div className="screen-navigation">{navigationControls}</div>
        <div className="loading-spinner"></div>
        <p>Loading datasets...</p>
      </div>
    );
  }

  if (!datasetReady) {
    if (showDocumentation) {
      return (
        <div className="app" data-theme={theme}>
          <header className="app-header">
            <h1>Himalayan Basin Visualization</h1>
            <div className="header-controls">
              {navigationControls}
              <button
                className="theme-toggle"
                onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
                aria-label="Toggle theme"
                title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              >
                {theme === 'dark' ? 'Light Theme' : 'Dark Theme'}
              </button>
            </div>
          </header>
          <div className="app-content docs-only-content">
            <Suspense fallback={<DeferredPanelFallback />}>
              <DocumentationPage
                selectedDataset={selectedDataset}
                selectedYearRange={activeYearRange}
                selectedVariable={selectedVariable}
                stats={stats}
              />
            </Suspense>
          </div>
        </div>
      );
    }

    return (
      <div className="dataset-screen">
        <div className="screen-navigation">{navigationControls}</div>
        <div className="dataset-card">
          <div className="setup-intro">
            <span className="setup-eyebrow">Hydrological research platform</span>
            <h2>Research project hub</h2>
            <p>Create a persistent project, continue saved work, or open a temporary exploration. Projects remember dashboard state and code between sessions.</p>
          </div>
          {error && <div className="dataset-error">{error}</div>}
          <div className="home-module-options" role="radiogroup" aria-label="Research workflow">
            <label className={`home-module-option ${homeModule === 'projects' ? 'active' : ''}`}>
              <input
                type="radio"
                name="home-module"
                value="projects"
                checked={homeModule === 'projects'}
                onChange={() => handleHomeModuleChange('projects')}
              />
              <div className="home-module-text">
                <div className="home-module-title">Projects</div>
                <div className="home-module-meta">Create, open, and continue permanent research workspaces.</div>
              </div>
            </label>
            <label className={`home-module-option ${homeModule === 'dashboard' ? 'active' : ''}`}>
              <input
                type="radio"
                name="home-module"
                value="dashboard"
                checked={homeModule === 'dashboard'}
                onChange={() => handleHomeModuleChange('dashboard')}
              />
              <div className="home-module-text">
                <div className="home-module-title">Explore & analyze</div>
                <div className="home-module-meta">Interactive map, variables, time series, research methods, and code.</div>
              </div>
            </label>
            <label className={`home-module-option ${homeModule === 'outcomes' ? 'active' : ''}`}>
              <input
                type="radio"
                name="home-module"
                value="outcomes"
                checked={homeModule === 'outcomes'}
                onChange={() => handleHomeModuleChange('outcomes')}
              />
              <div className="home-module-text">
                <div className="home-module-title">Review outcomes</div>
                <div className="home-module-meta">Inspect precomputed research outputs and comparisons.</div>
              </div>
            </label>
          </div>
          {homeModule === 'projects' && (
            <Suspense fallback={<DeferredPanelFallback />}>
              <ProjectsHome
                projects={projects}
                loading={projectsLoading}
                error={projectsError}
                onCreate={handleCreateProject}
                onOpen={handleOpenProject}
                onArchive={handleArchiveProject}
              />
            </Suspense>
          )}
          {homeModule === 'dashboard' && (
            <>
              <section className="setup-section" aria-labelledby="dataset-heading">
                <div className="setup-section-heading">
                  <span className="setup-step">1</span>
                  <div style={{ flex: 1 }}>
                    <h3 id="dataset-heading">Data source</h3>
                    <p>Select the collection that will drive the map, variables, and time series.</p>
                  </div>
                  <button
                    type="button"
                    className="dataset-path-inline-btn"
                    onClick={() => setDatasetConfigModalOpen(true)}
                    title="Configure or change database folder path"
                  >
                    📁 Change Folder
                  </button>
                </div>
                {(datasets.length === 0 || datasets.every((d) => !d.ready)) && (
                  <div className="dataset-empty-banner">
                    <span className="warning-icon">⚠️</span>
                    <div>
                      <strong>No dataset files found in current database folder.</strong>
                      <p>Please provide the path to your dataset folder containing parquet or geotiff files.</p>
                    </div>
                    <button
                      type="button"
                      className="dataset-empty-action-btn"
                      onClick={() => setDatasetConfigModalOpen(true)}
                    >
                      Locate Dataset Folder
                    </button>
                  </div>
                )}
                <div className="dataset-options">
                  {datasets.map((dataset) => (
                    <label
                      key={dataset.id}
                      className={`dataset-option ${datasetId === dataset.id ? 'active' : ''} ${!dataset.ready ? 'disabled' : ''}`}
                    >
                      <input
                        type="radio"
                        name="dataset"
                        value={dataset.id}
                        checked={datasetId === dataset.id}
                        disabled={!dataset.ready}
                        onChange={() => setDatasetId(dataset.id)}
                      />
                      <div className="dataset-text">
                        <div className="dataset-name">{dataset.label}</div>
                        <div className="dataset-meta">
                          {dataset.parquet_files} parquet · {dataset.geotiff_files || 0} geotiff · {dataset.csv_files} csv
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              </section>
              <details className="nc-upload-panel advanced-panel">
                <summary>
                  <span>Import NetCDF dataset</span>
                  <small>Advanced data source</small>
                </summary>
                <div className="advanced-panel-body">
                  <div className="nc-upload-header">
                    <h3>Upload NetCDF (.nc)</h3>
                    <button
                      type="button"
                      className="nc-help-btn"
                      title="Show accepted NetCDF rules"
                      aria-label="Show accepted NetCDF rules"
                      onClick={() => setShowNcHelp((prev) => !prev)}
                    >
                      ?
                    </button>
                  </div>
                  <p>Add a satellite NetCDF and convert it into a local parquet dataset without changing the existing ones.</p>
                  {showNcHelp && (
                    <div className="nc-help-box">
                      <div><strong>Accepted file extensions:</strong> .nc, .nc4, .cdf, .netcdf</div>
                      <div><strong>Time support:</strong> works with standard time coords; if missing, app creates a fallback date.</div>
                      <div><strong>Spatial coords:</strong> latitude/longitude are auto-detected from names or CF metadata.</div>
                      <div><strong>Grid format:</strong> supports 1D/1D, 2D/2D and common model-style lat/lon layouts.</div>
                      <div><strong>Variables:</strong> ingests numeric spatial variables (with or without explicit time dim).</div>
                      <div><strong>Elevation:</strong> optional; if missing, default elevation is used.</div>
                      <div><strong>Behavior:</strong> data is converted to parquet and stored as a new reusable dataset.</div>
                    </div>
                  )}
                  <div className="nc-upload-row">
                    <label htmlFor="nc-dataset-name">Dataset Name (optional)</label>
                    <input
                      id="nc-dataset-name"
                      type="text"
                      value={ncDatasetName}
                      onChange={(e) => setNcDatasetName(e.target.value)}
                      placeholder="e.g. Sentinel Snow 2024"
                      disabled={ncUploading}
                    />
                  </div>
                  <div className="nc-upload-row">
                    <label htmlFor="nc-file-input">NetCDF File</label>
                    <input
                      id="nc-file-input"
                      type="file"
                      accept=".nc,.nc4,.cdf,.netcdf"
                      onChange={(e) => setNcFile(e.target.files?.[0] || null)}
                      disabled={ncUploading}
                    />
                  </div>
                  {ncUploadError && <div className="dataset-error">{ncUploadError}</div>}
                  {ncUploadMessage && <div className="dataset-success">{ncUploadMessage}</div>}
                  <button
                    className="dataset-start-btn nc-upload-btn"
                    type="button"
                    onClick={handleNcUpload}
                    disabled={ncUploading || !ncFile}
                  >
                    {ncUploading ? 'Uploading & Converting...' : 'Upload NC Dataset'}
                  </button>
                </div>
              </details>
              <section className="year-range-panel setup-section" aria-labelledby="year-range-heading">
                <div className="setup-section-heading">
                  <span className="setup-step">2</span>
                  <div>
                    <h3 id="year-range-heading">Time window</h3>
                    <p>Use the smallest period needed for faster indexing and loading.</p>
                  </div>
                </div>
                {yearRangeLoading && <div className="year-range-loading">Loading available years...</div>}
                {yearRangeError && <div className="dataset-error">{yearRangeError}</div>}
                {!yearRangeLoading && !yearRangeError && yearMin !== null && yearMax !== null && (
                  <>
                    <div className="year-input-grid">
                      <div className="year-input-group">
                        <label htmlFor="year-start-input">Start Year</label>
                        <input
                          id="year-start-input"
                          type="number"
                          min={yearMin}
                          max={yearMax}
                          value={selectedYearRange.start ?? yearMin}
                          onChange={(e) => handleYearStartChange(e.target.value)}
                        />
                      </div>
                      <div className="year-input-group">
                        <label htmlFor="year-end-input">End Year</label>
                        <input
                          id="year-end-input"
                          type="number"
                          min={yearMin}
                          max={yearMax}
                          value={selectedYearRange.end ?? yearMax}
                          onChange={(e) => handleYearEndChange(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="year-slider-block">
                      <label htmlFor="year-start-slider">
                        Start: <strong>{selectedYearRange.start ?? yearMin}</strong>
                      </label>
                      <input
                        id="year-start-slider"
                        type="range"
                        min={yearMin}
                        max={yearMax}
                        step="1"
                        value={selectedYearRange.start ?? yearMin}
                        onChange={(e) => handleYearStartChange(e.target.value)}
                      />
                    </div>
                    <div className="year-slider-block">
                      <label htmlFor="year-end-slider">
                        End: <strong>{selectedYearRange.end ?? yearMax}</strong>
                      </label>
                      <input
                        id="year-end-slider"
                        type="range"
                        min={yearMin}
                        max={yearMax}
                        step="1"
                        value={selectedYearRange.end ?? yearMax}
                        onChange={(e) => handleYearEndChange(e.target.value)}
                      />
                    </div>
                    <div className="year-range-summary">
                      Selected: {selectedYearRange.start ?? yearMin} to {selectedYearRange.end ?? yearMax}
                    </div>
                  </>
                )}
              </section>
              <section className="home-region-card" aria-labelledby="home-region-heading">
                <div className="home-region-heading">
                  <div className="setup-section-heading">
                    <span className="setup-step">3</span>
                    <div>
                      <h3 id="home-region-heading">Study region</h3>
                      <p>Optionally start from a basin or glacier. Draw the ROI and other polygons on the map.</p>
                    </div>
                  </div>
                  <span className={`home-region-status ${selectedSubregionId ? 'active' : ''}`}>
                    {regionContextLabel}
                  </span>
                </div>
                {renderRegionSelectionPanel('region-panel home-region-controls')}
              </section>
              <div className="setup-actions">
                <div className="setup-ready-summary" aria-live="polite">
                  <strong>{selectedDataset?.label || 'Select a data source'}</strong>
                  <span>{activeYearRange ? `${activeYearRange.start}–${activeYearRange.end}` : 'Choose a time window'} · {regionContextLabel}</span>
                </div>
                <button
                  className="dataset-start-btn"
                  type="button"
                  onClick={handleStartDataset}
                  disabled={
                    !selectedDataset ||
                    !selectedDataset.ready ||
                    yearRangeLoading ||
                    !activeYearRange
                  }
                >
                  Open map workspace
                </button>
              </div>
            </>
          )}
          {homeModule === 'outcomes' && (
            <>
              <section className="setup-section" aria-labelledby="outcome-heading">
                <div className="setup-section-heading">
                  <span className="setup-step">1</span>
                  <div>
                    <h3 id="outcome-heading">Research output</h3>
                    <p>Select a completed analysis to inspect its spatial results and evidence.</p>
                  </div>
                </div>
                <div className="dataset-options">
                  {outcomes.map((outcome) => (
                    <label
                      key={outcome.id}
                      className={`dataset-option ${selectedOutcomeId === outcome.id ? 'active' : ''} ${!outcome.ready ? 'disabled' : ''}`}
                    >
                      <input
                        type="radio"
                        name="outcome"
                        value={outcome.id}
                        checked={selectedOutcomeId === outcome.id}
                        disabled={!outcome.ready}
                        onChange={() => setSelectedOutcomeId(outcome.id)}
                      />
                      <div className="dataset-text">
                        <div className="dataset-name">{outcome.label}</div>
                        <div className="dataset-meta">
                          {outcome.description}
                        </div>
                        <div className="dataset-meta">
                          dataset: {String(outcome.dataset || '').toUpperCase()} | status: {outcome.ready ? 'ready' : 'missing outputs'}
                        </div>
                      </div>
                    </label>
                  ))}
                  {outcomes.length === 0 && (
                    <div className="dataset-meta">No outcome modules found from backend.</div>
                  )}
                </div>
              </section>
              <button
                className="dataset-start-btn"
                type="button"
                onClick={handleStartOutcome}
                disabled={!selectedOutcome || !selectedOutcome.ready}
              >
                Open outcome workspace
              </button>
            </>
          )}
          <button
            className="dataset-docs-btn"
            type="button"
            onClick={handleToggleDocumentation}
          >
            Scientific documentation
          </button>
        </div>
      </div>
    );
  }

  // Loading screen
  if (loading) {
    return (
      <div className="loading-screen">
        <div className="screen-navigation">{navigationControls}</div>
        <div className="loading-spinner"></div>
        <p>Loading temperature data...</p>
      </div>
    );
  }

  // Error screen
  if (error) {
    return (
      <div className="error-screen">
        <div className="screen-navigation">{navigationControls}</div>
        <div className="error-icon">!</div>
        <h2>Connection Error</h2>
        <p>{error}</p>
        <div className="error-instructions">
          <h3>To start the backend:</h3>
          <ol>
            <li>Open terminal in <code>Webapp/backend</code></li>
            <li>Install dependencies: <code>pip install -r requirements.txt</code></li>
            <li>Run server: <code>python main.py</code></li>
          </ol>
        </div>
      </div>
    );
  }

  return (
    <div className="app" data-theme={theme}>
      {/* Header */}
      <header className="app-header dashboard-header">
        <div className="dashboard-brand">
          <div className="dashboard-title">
            <h1>Himalayan Basin</h1>
            <span>Hydrological research workspace</span>
          </div>
          {!showDocumentation && (
            <div className="dashboard-method-buttons">
              <button
                type="button"
                className={`dashboard-code-toggle ${researchPanelOpen ? 'active' : ''}`}
                onClick={handleToggleResearchPanel}
                title={researchPanelOpen ? 'Close guided research methods' : 'Apply research methods to this dashboard selection'}
                aria-pressed={researchPanelOpen}
              >
                Research methods
              </button>
              <button
                type="button"
                className={`dashboard-code-toggle ${codePanelOpen ? 'active' : ''}`}
                onClick={handleToggleCodePanel}
                title={codePanelOpen ? 'Close Python code workspace' : 'Open Python code workspace'}
                aria-pressed={codePanelOpen}
              >
                Code
              </button>
              <button
                type="button"
                className="dashboard-code-toggle export-data-btn"
                onClick={() => setExportModalOpen(true)}
                title="Export data for this ROI (temporal CSV, spatial maps)"
              >
                <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 15, height: 15, marginRight: 4, verticalAlign: 'middle' }}>
                  <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
                </svg>
                Export
              </button>
              <button
                type="button"
                className={`dashboard-code-toggle dataset-path-btn ${datasetConfig?.is_empty ? 'has-warning' : ''}`}
                onClick={() => setDatasetConfigModalOpen(true)}
                title={datasetConfig?.is_empty ? 'Warning: No datasets found. Click to configure dataset path.' : 'Configure dataset folder path'}
              >
                <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 15, height: 15, marginRight: 4, verticalAlign: 'middle' }}>
                  <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                </svg>
                Data Folder
                {datasetConfig?.is_empty && <span className="dataset-dot-warning" />}
              </button>
            </div>
          )}
        </div>
        {!showDocumentation && (
          <div className="header-search">
            <div
              className={`map-search-trigger ${searchToolsOpen ? 'active' : ''}`}
              role="search"
            >
              <span className="search-mark">Search</span>
              <input
                className="map-search-input"
                value={subregionSearchText}
                onFocus={() => {
                  setSearchToolsOpen(true);
                  setActiveToolPanel('');
                  setSubregionDropdownOpen(true);
                }}
                onChange={(event) => {
                  setSubregionSearchText(event.target.value);
                  setSearchToolsOpen(true);
                  setActiveToolPanel('');
                  setSubregionDropdownOpen(true);
                  if (selectedSubregionId) {
                    setSelectedSubregionId('');
                    setSelectedSubregionFeature(null);
                  }
                }}
                placeholder="Search basin or glacier"
                aria-label="Search regions or glaciers"
              />
              {selectedSubregion && (
                <span className="search-chip">{selectedSubregion.label}</span>
              )}
              <button
                type="button"
                className="search-tools-toggle"
                onClick={() => {
                  setSearchToolsOpen((prev) => !prev);
                  setActiveToolPanel('');
                  setSubregionDropdownOpen(true);
                }}
                aria-expanded={searchToolsOpen}
                aria-label="Open coordinate and region tools"
              >
                Tools
              </button>
            </div>
            {searchToolsOpen && (
              <div className="map-search-mega">
                <div className="mega-heading">
                  <div>
                    <strong>Map Search & Region Tools</strong>
                    <span>Coordinates, sub-basins, glacier regions, and polygons.</span>
                  </div>
                  <button
                    type="button"
                    className="mega-close"
                    onClick={() => setSearchToolsOpen(false)}
                    aria-label="Close search tools"
                  >
                    Close
                  </button>
                </div>
                {renderQuickRegionResults()}
                <div className="mega-grid">
                  {renderRegionSelectionPanel('region-panel mega-card', false)}
                </div>
              </div>
            )}
          </div>
        )}
        <div className="header-controls">
          {navigationControls}
          {activeProject && !showDocumentation && (
            <div className="active-project-control" title={activeProject.description || 'Persistent project workspace'}>
              <span className={`project-save-dot ${projectDirty ? 'dirty' : ''}`} aria-hidden="true" />
              <span className="active-project-name">{activeProject.name}</span>
              <span className="active-project-state">
                {projectSaveState === 'saving' ? 'Saving…' : projectSaveState === 'error' ? 'Save failed' : projectDirty ? 'Unsaved' : 'Saved'}
              </span>
              <button
                type="button"
                onClick={handleSaveProject}
                disabled={projectSaveState === 'saving' || (!projectDirty && projectSaveState !== 'error')}
                title="Save project (Ctrl+S)"
              >
                Save
              </button>
            </div>
          )}
          <button
            className="home-btn"
            onClick={handleGoHome}
            type="button"
            title="Back to dataset selection"
          >
            Home
          </button>
          <button
            className={`docs-toggle-btn ${showDocumentation ? 'active' : ''}`}
            onClick={handleToggleDocumentation}
            type="button"
            title="Open methods and computation notes"
          >
            {showDocumentation ? 'Analysis' : 'Docs'}
          </button>
          {selectedDataset && (
            <div className="dataset-badge" title="Active dataset and time window">
              {selectedDataset.label}
              {activeYearRange && ` · ${activeYearRange.start}–${activeYearRange.end}`}
            </div>
          )}
          <button
            className="theme-toggle"
            onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
            aria-label="Toggle theme"
            title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
        </div>
      </header>

      {!showDocumentation && (
        <div className="analysis-strip">
          <div className="strip-left">
            <button
              type="button"
              className={`strip-btn ${activeToolPanel === 'variables' ? 'active' : ''}`}
              onClick={() => {
                setActiveToolPanel((prev) => (prev === 'variables' ? '' : 'variables'));
                setSearchToolsOpen(false);
              }}
              title={`Variable: ${variableLabel || 'Select a variable'}`}
              aria-expanded={activeToolPanel === 'variables'}
            >
              <span>Variable</span>
              <strong>{displayedVariableLabel || 'Select'}</strong>
            </button>
            <button
              type="button"
              className={`strip-btn ${activeToolPanel === 'elevation' ? 'active' : ''}`}
              onClick={() => {
                setActiveToolPanel((prev) => (prev === 'elevation' ? '' : 'elevation'));
                setSearchToolsOpen(false);
              }}
              title={`Elevation: ${selectedElevRange.min}m - ${selectedElevRange.max}m`}
              aria-expanded={activeToolPanel === 'elevation'}
            >
              <span>Elevation</span>
              <strong>{selectedElevRange.min}–{selectedElevRange.max} m</strong>
            </button>
            <button
              type="button"
              className={`strip-btn icon-btn ${activeToolPanel === 'summary' ? 'active' : ''}`}
              onClick={() => {
                setActiveToolPanel((prev) => (prev === 'summary' ? '' : 'summary'));
                setSearchToolsOpen(false);
              }}
              title="Live summary of the current selection"
              aria-expanded={activeToolPanel === 'summary'}
            >
              <span>Region</span>
              <strong>{regionContextLabel}</strong>
            </button>
            <button
              type="button"
              className={`strip-btn ${activeToolPanel === 'hotspot' ? 'active' : ''} ${(isHotspotMode || isOutcomeMode) ? 'mode-on' : ''}`}
              onClick={() => {
                setActiveToolPanel((prev) => (prev === 'hotspot' ? '' : 'hotspot'));
                setSearchToolsOpen(false);
              }}
              title={`Analysis: ${analysisContextLabel}`}
              aria-expanded={activeToolPanel === 'hotspot'}
            >
              <span>Analysis</span>
              <strong>{analysisContextLabel}</strong>
            </button>
          </div>
          <div className="strip-right">
            {stats && (
              <span className="mini-status" title={`${stats.total_files} files · ${stats.total_size_mb} MB`}>
                {stats.total_dates} dates
              </span>
            )}
            <span className="mini-status"><b>{isOutcomeMode ? 'Layer' : 'Date'}</b> {isOutcomeMode ? outcomeMapTitle : (formatDisplayDate(currentDate) || 'Loading')}</span>
            <span className="mini-status"><b>Points</b> {mapPointCount.toLocaleString()}</span>
          </div>
          {activeToolPanel && (
            <div className={`strip-popover strip-popover-${activeToolPanel}`}>
              <button
                type="button"
                className="strip-popover-close"
                onClick={() => setActiveToolPanel('')}
                aria-label="Close toolbar panel"
              >
                Close
              </button>
              {activeToolPanel === 'variables' && renderVariablePanel('variable-panel strip-card')}
              {activeToolPanel === 'elevation' && renderElevationPanel('strip-elevation-panel strip-card')}
              {activeToolPanel === 'summary' && renderLiveSummaryPanel('info-panel strip-card')}
              {activeToolPanel === 'hotspot' && renderHotspotPanel('hotspot-panel strip-card')}
            </div>
          )}
        </div>
      )}

      {/* Main content */}
      <div
        ref={appContentRef}
        className={`app-content ${showDocumentation ? 'docs-only-content' : ''} ${(codePanelOpen || researchPanelOpen) ? 'code-split-content' : ''}`}
      >
        {showDocumentation ? (
          <Suspense fallback={<DeferredPanelFallback />}>
            <DocumentationPage
              selectedDataset={selectedDataset}
              selectedYearRange={activeYearRange}
              selectedVariable={selectedVariable}
              stats={stats}
            />
          </Suspense>
        ) : (
          <>
            {researchPanelOpen && (
              <Suspense fallback={<DeferredPanelFallback />}>
                <ResearchToolkitPanel
                  datasets={datasets}
                  datasetId={datasetId}
                  datasetLabel={selectedDataset?.label || ''}
                  variables={variables}
                  selectedVariable={selectedVariable}
                  comparisonVariables={comparisonVariables}
                  yearRange={activeYearRange}
                  selectedElevRange={selectedElevRange}
                  selectedSubregionId={selectedSubregionId}
                  selectedSubregionLabel={selectedSubregion?.label || ''}
                  selectedAoi={roiPolygon}
                  onClose={handleCloseResearchPanel}
                  onMapOutputChange={handleResearchMapOutputChange}
                  initialWorkspaceState={projectToolState.research}
                  onWorkspaceStateChange={handleResearchWorkspaceStateChange}
                  outputPortalTargetId={researchPanelOpen ? 'research-output-dock' : null}
                  panelWidth={codePanelWidth}
                />
              </Suspense>
            )}
            {codePanelOpen && (
              <Suspense fallback={<DeferredPanelFallback />}>
                <DashboardCodePanel
                  key={activeProject?.id || 'temporary-code-panel'}
                  theme={theme}
                  datasetId={datasetId}
                  datasetLabel={selectedDataset?.label || ''}
                  yearRange={activeYearRange}
                  currentDate={currentDate}
                  dates={dates}
                  selectedVariable={selectedVariable}
                  selectedElevRange={selectedElevRange}
                  selectedSubregionId={selectedSubregionId}
                  selectedSubregionLabel={selectedSubregion?.label || ''}
                  onClose={handleCloseCodePanel}
                  onMapOutputChange={handleCodeMapOutputChange}
                  initialWorkspaceState={projectToolState.code}
                  onWorkspaceStateChange={handleCodeWorkspaceStateChange}
                  workspaceStateRef={codeWorkspaceLiveRef}
                  outputPortalTargetId={codePanelOpen ? 'code-output-dock' : null}
                  panelWidth={codePanelWidth}
                />
              </Suspense>
            )}
            {(codePanelOpen || researchPanelOpen) && (
              <div
                className="code-resize-handle"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize analysis tools and map panels"
                title="Drag to resize tools panel"
                onMouseDown={handleCodeResizeStart}
              />
            )}
            <main className="main-content">
              {/* Map */}
              <div className="map-container">
                <Suspense fallback={<DeferredPanelFallback />}>
                  <MapView
                    data={displayedMapData}
                    currentDate={displayedMapDate}
                    theme={theme}
                    variableLabel={displayedVariableLabel}
                    selectedSubregionFeature={selectedSubregionFeature}
                    glacierViewEnabled={hasToolMapOutput ? false : glacierViewEnabled}
                    glacierFilterBounds={selectedMapBounds}
                    glacierFilterAoi={roiPolygon}
                    glacierFilterSubregionId={selectedSubregionId || undefined}
                    focusLocations={focusLocations}
                    onUpdateFocusLocation={handleUpdateFocusLocation}
                    onRemoveFocusLocation={handleRemoveFocusLocation}
                    analysisMode={displayedAnalysisMode}
                    hotspotSummary={hasToolMapOutput ? null : hotspotSummary}
                    layerStyle={displayedLayerStyle}
                    atlasRegions={subregions}
                    polygonDrawEnabled={polygonDrawMode}
                    onPolygonDrawToggle={handleTogglePolygonDraw}
                    onAoiComplete={handleAoiComplete}
                    aoiPolygons={aoiPolygons}
                    selectedAoiId={selectedAoiId}
                    onAoiSelect={setSelectedAoiId}
                    onShapefileLoad={handleShapefileLoad}
                    shapefileLoading={shapefileLoading}
                  />
                </Suspense>
                {(selectedAnalysisItems.length > 0 || glacierViewEnabled || focusLocations.length > 0 || aoiPolygons.length > 0 || selectedSubregionId) && (
                  <div className="map-layers-panel" onMouseDown={(e) => e.stopPropagation()}>
                    <h4>Map Layers</h4>
                    <div className="layer-items">
                      {glacierViewEnabled && (
                        <div className="layer-item analysis-layer-item active">
                          <button
                            type="button"
                            className="layer-activate"
                            onClick={() => setMapViewMode('glacier')}
                            title="Glacier outline overlay"
                            aria-pressed="true"
                          >
                            <span className="layer-name">Glaciers</span>
                            <span className="layer-meta">
                              {roiPolygon ? 'ROI neighborhood' : selectedSubregionId ? 'Selected region' : 'Visible map'}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="layer-remove"
                            title="Remove glacier overlay"
                            onClick={(e) => {
                              e.stopPropagation();
                              setMapViewMode('basin');
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      )}
                      {selectedAnalysisItems.map((item, index) => {
                        const isActive = index === 0;
                        const graphEntry = analysisGraphEntries[item.id] || {};
                        return (
                          <div
                            key={item.id}
                            className={`layer-item analysis-layer-item ${isActive ? 'active' : ''}`}
                          >
                            <button
                              type="button"
                              className="layer-activate"
                              onClick={() => handleActivateAnalysisItem(item.id)}
                              title={isActive ? 'Active spatial layer' : 'View this layer on the map'}
                              aria-pressed={isActive}
                            >
                              <span className="layer-name">{item.variableLabel}</span>
                              <span className="layer-meta">{item.datasetLabel} · {item.yearRange.start}-{item.yearRange.end}</span>
                              {graphEntry.loading && <span className="layer-status">Updating</span>}
                            </button>
                            <button
                              type="button"
                              className="layer-remove"
                              title="Remove analysis layer"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRemoveAnalysisItem(item.id);
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}
                      {aoiPolygons.map((polygon) => {
                        const selected = polygon.id === selectedAoiId;
                        return (
                          <div
                            key={polygon.id}
                            className={`layer-item overlay-layer-item aoi-layer-item ${selected ? 'active' : ''}`}
                            onClick={() => setSelectedAoiId(polygon.id)}
                          >
                            <div className="aoi-layer-main">
                              <input
                                type="text"
                                value={polygon.name}
                                onFocus={() => setSelectedAoiId(polygon.id)}
                                onChange={(e) => handleRenameAoi(polygon.id, e.target.value)}
                                className="layer-input"
                                title="Rename polygon"
                              />
                              {polygon.role === 'roi' && <div className="layer-meta">ROI</div>}
                              {polygon.metadata?.source === 'shapefile' && (
                                <div className="layer-meta">
                                  <span className="aoi-source-badge shapefile">SHP</span>
                                  <span className="aoi-source-badge saved">Saved</span>
                                </div>
                              )}
                            </div>
                            <button
                              type="button"
                              className="layer-remove"
                              title="Remove polygon"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRemoveAoi(polygon.id);
                              }}
                            >
                              ✕
                            </button>
                          </div>
                        );
                      })}
                      {selectedPolygon && (
                        <div className="aoi-details">
                          <button
                            type="button"
                            className="aoi-clear-selection"
                            onClick={() => setSelectedAoiId('')}
                          >
                            Hide details
                          </button>
                          {selectedPolygon.role === 'roi' && (
                            <div className="aoi-details-row">
                              <span>Role</span>
                              <strong>ROI · variable loading boundary</strong>
                            </div>
                          )}
                          <div className="aoi-details-row">
                            <span>Area</span>
                            <strong>{selectedPolygon.analysis.areaKm2.toFixed(2)} km²</strong>
                          </div>
                          <div className="aoi-details-row">
                            <span>Geometry</span>
                            <strong>{selectedPolygon.analysis.geometryType} · {selectedPolygon.analysis.focus}</strong>
                          </div>
                          <div className="aoi-details-row">
                            <span>Perimeter</span>
                            <strong>{selectedPolygon.analysis.perimeterKm.toFixed(2)} km</strong>
                          </div>
                          {selectedPolygon.analysis.centroid && (
                            <div className="aoi-details-row">
                              <span>Centroid</span>
                              <strong>{selectedPolygon.analysis.centroid.lat.toFixed(4)}, {selectedPolygon.analysis.centroid.lon.toFixed(4)}</strong>
                            </div>
                          )}
                          <details>
                            <summary>Vertex coordinates</summary>
                            <ol className="aoi-coordinate-list">
                              {getAoiVertices(selectedPolygon).map(([lon, lat], index) => (
                                <li key={`${selectedPolygon.id}-${index}`}>
                                  {Number(lat).toFixed(5)}, {Number(lon).toFixed(5)}
                                </li>
                              ))}
                            </ol>
                          </details>
                          <div className="aoi-analysis-note">
                            {selectedPolygon.analysis.focus === 'Glacier'
                              ? 'Glacier area and retreat workflows can use this boundary.'
                              : selectedPolygon.analysis.focus === 'Watershed'
                                ? 'Catchment workflows can use this boundary.'
                                : selectedPolygon.analysis.focus === 'Lake/reservoir'
                                  ? 'Surface-area workflows can use this boundary.'
                                  : 'Ready for polygon-based analysis.'}
                          </div>
                        </div>
                      )}
                      {selectedSubregionId && (
                        <div className="layer-item overlay-layer-item">
                          <input
                            type="text"
                            value={selectedSubregion?.label || 'Selected basin'}
                            readOnly
                            className="layer-input"
                            title="Selected basin or glacier"
                          />
                          <button
                            type="button"
                            className="layer-remove"
                            title="Remove active basin/glacier filter"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedSubregionId('');
                              setSelectedSubregionFeature(null);
                              setSubregionSearchText('');
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      )}
                      {focusLocations.map((loc) => (
                        <div key={loc.id} className="layer-item overlay-layer-item">
                          <input
                            type="text"
                            value={loc.label !== undefined ? loc.label : `Pin: ${loc.lat.toFixed(2)}, ${loc.lon.toFixed(2)}`}
                            onChange={(e) => {
                              setFocusLocations((prev) => prev.map((l) => l.id === loc.id ? { ...l, label: e.target.value } : l));
                            }}
                            className="layer-input"
                            title="Rename Pin Layer"
                          />
                          <button
                            type="button"
                            className="layer-remove"
                            title="Remove pin layer"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveFocusLocation(loc.id);
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div
                className={`bottom-analysis-panel ${(codePanelOpen || researchPanelOpen) ? 'code-output-mode' : ''}`}
                style={{ height: `${bottomPanelHeight}px` }}
              >
                <div
                  className="bottom-resize-handle"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize bottom analysis panel"
                  title="Drag to resize bottom panel"
                  onMouseDown={handleBottomResizeStart}
                />
                {(codePanelOpen || researchPanelOpen) ? (
                  <div
                    id={researchPanelOpen ? 'research-output-dock' : 'code-output-dock'}
                    className="code-output-dock"
                  />
                ) : (
                  <>
                    <div className="controls-container">
                      {isHotspotMode && (
                        <div className="hotspot-time-note">
                          Hotspot mode uses the full selected year range for trend fitting. The time slider only moves the graph marker.
                        </div>
                      )}
                      {!isOutcomeMode && (
                        <TimeSlider
                          dates={dates}
                          currentIndex={currentDateIndex}
                          isPlaying={isPlaying}
                          playSpeed={playSpeed}
                          onDateChange={handleDateChange}
                          onPlayPause={handlePlayPause}
                          onSpeedChange={handleSpeedChange}
                        />
                      )}
                    </div>

                    <div className="graph-container">
                      {isOutcomeMode ? (
                        renderOutcomeSummaryPanel()
                      ) : selectedAnalysisItems.length === 0 ? (
                        <div className="analysis-empty-state">
                          No analysis layers selected.
                        </div>
                      ) : (
                        <Suspense fallback={<DeferredPanelFallback />}>
                          <div className="analysis-graphs-list">
                            {selectedAnalysisItems.map((item, index) => {
                              const graphEntry = analysisGraphEntries[item.id] || {};
                              const hasGraphData = Array.isArray(graphEntry.data) && graphEntry.data.length > 0;
                              return (
                                <section
                                  className={`analysis-graph-card ${index === 0 ? 'active' : ''}`}
                                  key={item.id}
                                  style={{ height: `${analysisGraphHeights[item.id] || 340}px` }}
                                >
                                  <div className="analysis-card-toolbar">
                                    <button
                                      type="button"
                                      className="analysis-card-title"
                                      onClick={() => handleActivateAnalysisItem(item.id)}
                                      aria-pressed={index === 0}
                                      title={index === 0 ? 'Active spatial layer' : 'Show this variable on the map'}
                                    >
                                      <strong>{item.variableLabel}</strong>
                                      <span>{item.datasetLabel} · {item.yearRange.start}-{item.yearRange.end}</span>
                                    </button>
                                    <div className="analysis-card-actions">
                                      {graphEntry.loading && (
                                        <span className="analysis-card-status">Updating</span>
                                      )}
                                      <button
                                        type="button"
                                        className="analysis-card-action"
                                        onClick={() => handleActivateAnalysisItem(item.id)}
                                        title={index === 0 ? 'Active spatial layer' : 'Show this variable on the map'}
                                      >
                                        Map
                                      </button>
                                      <button
                                        type="button"
                                        className="analysis-card-remove"
                                        onClick={() => handleRemoveAnalysisItem(item.id)}
                                        title="Remove this analysis"
                                      >
                                        Remove
                                      </button>
                                    </div>
                                  </div>
                                  {graphEntry.error && !hasGraphData ? (
                                    <div className="analysis-graph-message error">{graphEntry.error}</div>
                                  ) : graphEntry.loading && !hasGraphData ? (
                                    <div className="analysis-graph-message">Loading graph data...</div>
                                  ) : (
                                    <>
                                      {graphEntry.error && (
                                        <div className="analysis-graph-message warning">{graphEntry.error}</div>
                                      )}
                                      <div className="analysis-graph-body">
                                        <TempGraph
                                          data={graphEntry.data || []}
                                          currentDate={currentDate}
                                          variableLabel={item.variableLabel}
                                          series={[{ key: 'value', label: item.variableLabel }]}
                                          showPointStats={Boolean(roiPolygon || selectedSubregionId)}
                                          pointStatsLabel={roiPolygon || selectedSubregionId ? 'Region points/day' : 'Data points/day'}
                                        />
                                      </div>
                                    </>
                                  )}
                                  <div
                                    className="analysis-graph-resize-handle"
                                    role="separator"
                                    aria-orientation="horizontal"
                                    aria-label={`Resize ${item.variableLabel} graph`}
                                    title="Drag to resize graph"
                                    onMouseDown={(event) => handleAnalysisGraphResizeStart(item.id, event)}
                                  />
                                </section>
                              );
                            })}
                          </div>
                        </Suspense>
                      )}
                    </div>
                  </>
                )}
              </div>
            </main>
          </>
        )}
      </div>
      {exportModalOpen && (
        <Suspense fallback={null}>
          <ExportDataModal
            open={exportModalOpen}
            onClose={() => setExportModalOpen(false)}
            variables={variables}
            datasets={datasets}
            datasetId={datasetId}
            datasetLabel={datasets.find((d) => d.id === datasetId)?.label || datasetId}
            yearRange={activeYearRange}
            dates={dates}
            selectedSubregionId={selectedSubregionId}
            selectedSubregionLabel={selectedSubregion?.label || ''}
            roiPolygon={roiPolygon}
            elevRange={selectedElevRange}
          />
        </Suspense>
      )}
      {datasetConfigModalOpen && (
        <Suspense fallback={null}>
          <DatasetConfigModal
            open={datasetConfigModalOpen}
            onClose={() => setDatasetConfigModalOpen(false)}
            onPathConfigured={handleDatasetPathConfigured}
          />
        </Suspense>
      )}
    </div>
  );
}

export default App;
