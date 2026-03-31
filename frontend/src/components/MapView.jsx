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
const defaultPmtilesUrl = 'pmtiles://https://jay9115-himalaya-web-backend.hf.space/map-assets/india_admin.pmtiles';
const defaultBasinGeoJsonUrl = 'https://jay9115-himalaya-web-backend.hf.space/map-assets/upper_indus_basin.geojson';
const defaultGlyphsUrl = 'https://jay9115-himalaya-web-backend.hf.space/map-assets/fonts/{fontstack}/{range}.pbf';
const indiaPmBounds = [68.17751186879357, 6.752782631992444, 97.41289651394189, 37.08834177335065];
const indiaPmMaxZoom = 12;
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

const getColorForValue = (value, min, max) => {
  if (!Number.isFinite(value)) return [120, 120, 120, 80];
  if (max <= min) return [0, 150, 255, 200];
  const p20 = min + (max - min) * 0.2;
  const p40 = min + (max - min) * 0.4;
  const p60 = min + (max - min) * 0.6;
  const p80 = min + (max - min) * 0.8;

  if (value < p20) {
    return [0, 0, 255, 200];
  }
  if (value < p40) {
    return [0, 150, 255, 200];
  }
  if (value < p60) {
    return [0, 255, 0, 200];
  }
  if (value < p80) {
    return [255, 200, 0, 200];
  }
  return [255, 0, 0, 200];
};

function MapView({ data, currentDate, theme, variableLabel, selectionEnabled, onSelectionComplete, onSelectionPreview, selectionBounds, focusLocation }) {
  const lightStyleOverride = import.meta.env.VITE_MAP_STYLE_LIGHT;
  const darkStyleOverride = import.meta.env.VITE_MAP_STYLE_DARK;
  const pmtilesUrl = import.meta.env.VITE_INDIA_PM_TILES_URL || defaultPmtilesUrl;
  const basinGeoJsonUrl = import.meta.env.VITE_BASIN_GEOJSON_URL || defaultBasinGeoJsonUrl;
  const glyphsUrl = import.meta.env.VITE_GLYPHS_URL || defaultGlyphsUrl;

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
  const [basinGeoJson, setBasinGeoJson] = useState(null);

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
        url: pmtilesUrl,
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
  }, [pmtilesUrl, theme]);

  const handleMapLoad = useCallback(() => {
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
    let min = Infinity;
    let max = -Infinity;
    for (const point of data) {
      const value = point.value;
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
  }, [data]);

  const legendSteps = useMemo(() => {
    const { min, max } = valueRange;
    return [
      min,
      min + (max - min) * 0.2,
      min + (max - min) * 0.4,
      min + (max - min) * 0.6,
      min + (max - min) * 0.8,
      max,
    ];
  }, [valueRange]);

  const layers = useMemo(() => {
    const result = [];

    if (basinGeoJson) {
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

    if (!data || data.length === 0) {
      return result;
    }

    const scatterLayer = new ScatterplotLayer({
      id: 'variable-scatter',
      data: data,
      pickable: true,
      opacity: 0.7,
      stroked: false,
      filled: true,
      radiusScale: 1,
      radiusMinPixels: 2,
      radiusMaxPixels: 8,
      getPosition: (d) => [d.lon, d.lat],
      getRadius: 300,
      getFillColor: (d) => getColorForValue(d.value, valueRange.min, valueRange.max),
      updateTriggers: {
        getFillColor: [valueRange.min, valueRange.max],
      },
      parameters: { depthTest: false },
    });

    result.push(scatterLayer);
    return result;
  }, [data, valueRange, basinGeoJson, theme]);

  const getTooltip = ({ object }) => {
    if (!object) return null;

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
        controller={!selectionEnabled}
        layers={layers}
        getTooltip={getTooltip}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      >
        <Map
          ref={mapRef}
          mapStyle={mapStyle}
          attributionControl={false}
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
          {variableLabel || 'Value'} Scale
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '20px', height: '12px', background: 'rgb(0, 0, 255)', borderRadius: '2px' }}></div>
            <span>&lt; {legendSteps[1].toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '20px', height: '12px', background: 'rgb(0, 150, 255)', borderRadius: '2px' }}></div>
            <span>{legendSteps[1].toFixed(2)} to {legendSteps[2].toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '20px', height: '12px', background: 'rgb(0, 255, 0)', borderRadius: '2px' }}></div>
            <span>{legendSteps[2].toFixed(2)} to {legendSteps[3].toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '20px', height: '12px', background: 'rgb(255, 200, 0)', borderRadius: '2px' }}></div>
            <span>{legendSteps[3].toFixed(2)} to {legendSteps[4].toFixed(2)}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ width: '20px', height: '12px', background: 'rgb(255, 0, 0)', borderRadius: '2px' }}></div>
            <span>{legendSteps[4].toFixed(2)} to {legendSteps[5].toFixed(2)}</span>
          </div>
        </div>
        <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--map-overlay-border)', fontSize: '11px', color: 'var(--map-overlay-muted)' }}>
          {data.length.toLocaleString()} data points
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
        Date: {currentDate}
      </div>
    </div>
  );
}

export default React.memo(MapView);
