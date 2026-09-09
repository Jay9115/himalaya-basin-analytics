import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatDisplayDate, formatDisplayDateTime } from '../utils/dateUtils';
import './SnapshotLayout.css';

const PAGE_SIZES = {
  a4: { label: 'A4', width: 210, height: 297 },
  a3: { label: 'A3', width: 297, height: 420 },
  letter: { label: 'Letter', width: 216, height: 279 },
  square: { label: 'Square', width: 250, height: 250 },
};

const DEFAULT_SETTINGS = {
  title: 'Himalayan Basin — [% region %]',
  subtitle: '[% variable %] · [% date %]',
  pageSize: 'a4',
  orientation: 'landscape',
  margin: 12,
  dpi: 300,
  format: 'png',
  fit: 'contain',
  background: '#ffffff',
  frame: true,
  legend: true,
  northArrow: true,
  scaleBar: true,
  coordinates: true,
  timestamp: true,
  coordinateGrid: false,
  gridInterval: 'auto',
  gridStyle: 'lines',
  customVariables: 'organization=ISRO SAC\nauthor=',
  includeMetadataPage: false,
};

const TEMPLATE_STORAGE_KEY = 'hba-snapshot-layout-templates-v1';
const MAX_ATLAS_PAGES = 10;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const normalizeRect = (start, end) => ({
  left: Math.min(start.x, end.x),
  top: Math.min(start.y, end.y),
  width: Math.abs(end.x - start.x),
  height: Math.abs(end.y - start.y),
});

const safeFilename = (value) => String(value || 'map-snapshot')
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '') || 'map-snapshot';

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

const parseCustomVariables = (source) => Object.fromEntries(
  String(source || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line.includes('='))
    .map((line) => {
      const separator = line.indexOf('=');
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    })
    .filter(([key]) => key)
);

const buildExpressionVariables = (settings, metadata = {}) => ({
  ...parseCustomVariables(settings.customVariables),
  date: formatDisplayDate(metadata.currentDate) || '',
  variable: metadata.variableLabel || '',
  points: Number(metadata.pointCount || 0).toLocaleString(),
  min: Number(metadata.legendRange?.min ?? 0).toFixed(2),
  max: Number(metadata.legendRange?.max ?? 0).toFixed(2),
  region: metadata.region || 'Current selection',
  page: metadata.page || 1,
  pages: metadata.pages || 1,
  scale: metadata.scaleInfo?.label || '',
  now: formatDisplayDate(new Date()),
});

const resolveTemplate = (template, variables) => String(template || '').replace(
  /\[\%\s*([a-zA-Z0-9_.-]+)\s*\%\]|\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g,
  (match, qgisKey, mustacheKey) => {
    const key = qgisKey || mustacheKey;
    return Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key]) : match;
  },
);

const formatCoordinate = (value, positiveHemisphere, negativeHemisphere) => (
  `${Math.abs(value).toFixed(4)}° ${value >= 0 ? positiveHemisphere : negativeHemisphere}`
);

const haversineDistance = (left, right) => {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const latitude1 = toRadians(Number(left?.[1]));
  const latitude2 = toRadians(Number(right?.[1]));
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = toRadians(Number(right?.[0]) - Number(left?.[0]));
  const haversine = (Math.sin(deltaLatitude / 2) ** 2)
    + (Math.cos(latitude1) * Math.cos(latitude2) * (Math.sin(deltaLongitude / 2) ** 2));
  return 6371008.8 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
};

const getNiceScaleDistance = (targetMeters) => {
  if (!Number.isFinite(targetMeters) || targetMeters <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(targetMeters));
  const normalized = targetMeters / magnitude;
  const multiplier = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  return multiplier * magnitude;
};

const getNiceDegreeInterval = (range) => {
  const target = Math.max(1e-6, range / 5);
  const magnitude = 10 ** Math.floor(Math.log10(target));
  const normalized = target / magnitude;
  const multiplier = normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1;
  return multiplier * magnitude;
};

function drawCoordinateGrid(context, selection, scale, metadata, mapRect, settings) {
  if (!settings.coordinateGrid || !metadata?.unproject || !metadata?.project || !mapRect) return;
  const localCorners = [
    [selection.left - mapRect.left, selection.top - mapRect.top],
    [selection.left + selection.width - mapRect.left, selection.top - mapRect.top],
    [selection.left + selection.width - mapRect.left, selection.top + selection.height - mapRect.top],
    [selection.left - mapRect.left, selection.top + selection.height - mapRect.top],
  ];
  const geographicCorners = localCorners.map((point) => metadata.unproject(point));
  if (geographicCorners.some((point) => !point)) return;
  const longitudes = geographicCorners.map((point) => Number(point[0]));
  const latitudes = geographicCorners.map((point) => Number(point[1]));
  const minLongitude = Math.min(...longitudes);
  const maxLongitude = Math.max(...longitudes);
  const minLatitude = Math.min(...latitudes);
  const maxLatitude = Math.max(...latitudes);
  const requestedInterval = Number(settings.gridInterval);
  const interval = Number.isFinite(requestedInterval) && requestedInterval > 0
    ? requestedInterval
    : getNiceDegreeInterval(Math.max(maxLongitude - minLongitude, maxLatitude - minLatitude));
  if (!Number.isFinite(interval) || interval <= 0) return;

  const toOutput = (coordinate) => {
    const projected = metadata.project(coordinate);
    if (!projected) return null;
    return [
      (mapRect.left + projected[0] - selection.left) * scale,
      (mapRect.top + projected[1] - selection.top) * scale,
    ];
  };
  const traceLine = (fixedValue, isLongitude) => {
    context.beginPath();
    let started = false;
    const segments = 28;
    for (let index = 0; index <= segments; index += 1) {
      const ratio = index / segments;
      const coordinate = isLongitude
        ? [fixedValue, minLatitude + ((maxLatitude - minLatitude) * ratio)]
        : [minLongitude + ((maxLongitude - minLongitude) * ratio), fixedValue];
      const point = toOutput(coordinate);
      if (!point) continue;
      if (!started) {
        context.moveTo(point[0], point[1]);
        started = true;
      } else {
        context.lineTo(point[0], point[1]);
      }
    }
    if (started) context.stroke();
  };

  context.save();
  context.beginPath();
  context.rect(0, 0, selection.width * scale, selection.height * scale);
  context.clip();
  context.strokeStyle = 'rgba(18, 45, 61, 0.38)';
  context.lineWidth = Math.max(0.7, scale * 0.35);
  context.setLineDash(settings.gridStyle === 'crosses' ? [2 * scale, 5 * scale] : []);
  for (let longitude = Math.ceil(minLongitude / interval) * interval; longitude <= maxLongitude; longitude += interval) {
    traceLine(Number(longitude.toFixed(8)), true);
  }
  for (let latitude = Math.ceil(minLatitude / interval) * interval; latitude <= maxLatitude; latitude += interval) {
    traceLine(Number(latitude.toFixed(8)), false);
  }
  context.restore();
}

async function captureCanvases(mapElement, selection, scale = 1, renderDataOverlay, backgroundColor = '#ffffff') {
  const width = Math.max(1, Math.round(selection.width * scale));
  const height = Math.max(1, Math.round(selection.height * scale));
  const output = document.createElement('canvas');
  output.width = width;
  output.height = height;
  const context = output.getContext('2d', { alpha: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.fillStyle = backgroundColor;
  context.fillRect(0, 0, width, height);

  const allCanvases = Array.from(mapElement.querySelectorAll('canvas'));
  const orderedCanvases = [
    ...allCanvases.filter((canvas) => canvas.classList.contains('maplibregl-canvas')),
    ...allCanvases.filter((canvas) => !canvas.classList.contains('maplibregl-canvas')),
  ];

  let layersDrawn = 0;
  orderedCanvases.forEach((canvas) => {
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height || !canvas.width || !canvas.height) return;

    const left = Math.max(selection.left, bounds.left);
    const top = Math.max(selection.top, bounds.top);
    const right = Math.min(selection.left + selection.width, bounds.right);
    const bottom = Math.min(selection.top + selection.height, bounds.bottom);
    if (right <= left || bottom <= top) return;

    const sourceScaleX = canvas.width / bounds.width;
    const sourceScaleY = canvas.height / bounds.height;
    context.drawImage(
      canvas,
      (left - bounds.left) * sourceScaleX,
      (top - bounds.top) * sourceScaleY,
      (right - left) * sourceScaleX,
      (bottom - top) * sourceScaleY,
      (left - selection.left) * scale,
      (top - selection.top) * scale,
      (right - left) * scale,
      (bottom - top) * scale,
    );
    layersDrawn += 1;
  });

  // WebGL normally discards Deck.GL's drawing buffer after presenting a frame.
  // Repaint the scientific layer in this temporary 2D canvas only while a
  // snapshot is requested, avoiding preserveDrawingBuffer overhead on the map.
  renderDataOverlay?.(context, selection, scale);

  if (!layersDrawn) {
    throw new Error('The map canvas is not ready yet. Wait for the map to finish drawing and try again.');
  }
  return output;
}

function getPageDimensions(settings) {
  const page = PAGE_SIZES[settings.pageSize] || PAGE_SIZES.a4;
  const landscape = settings.orientation === 'landscape';
  const widthMm = landscape ? Math.max(page.width, page.height) : Math.min(page.width, page.height);
  const heightMm = landscape ? Math.min(page.width, page.height) : Math.max(page.width, page.height);
  return { widthMm, heightMm };
}

function getLayoutMetrics(settings, preview = false) {
  const { widthMm, heightMm } = getPageDimensions(settings);
  const dpi = preview ? 96 : Number(settings.dpi);
  const requestedWidth = Math.round((widthMm / 25.4) * dpi);
  const requestedHeight = Math.round((heightMm / 25.4) * dpi);
  const pageWidth = clamp(requestedWidth, 480, 6000);
  const pageHeight = clamp(requestedHeight, 360, 6000);
  const pxPerMm = pageWidth / widthMm;
  const margin = Number(settings.margin) * pxPerMm;
  const headerHeight = settings.title ? 19 * pxPerMm : 5 * pxPerMm;
  const footerHeight = (settings.timestamp || settings.coordinates) ? 10 * pxPerMm : 4 * pxPerMm;
  const mapY = margin + headerHeight;
  return {
    widthMm,
    heightMm,
    dpi,
    pageWidth,
    pageHeight,
    pxPerMm,
    margin,
    headerHeight,
    footerHeight,
    mapWidth: Math.max(1, pageWidth - (margin * 2)),
    mapHeight: Math.max(1, pageHeight - mapY - margin - footerHeight),
  };
}

function getCaptureScale(settings, selection, preview = false) {
  const metrics = getLayoutMetrics(settings, preview);
  const sourceRatio = selection.width / selection.height;
  const targetRatio = metrics.mapWidth / metrics.mapHeight;
  let drawWidth;
  let drawHeight;
  if ((settings.fit === 'cover' && sourceRatio > targetRatio)
    || (settings.fit === 'contain' && sourceRatio < targetRatio)) {
    drawHeight = metrics.mapHeight;
    drawWidth = drawHeight * sourceRatio;
  } else {
    drawWidth = metrics.mapWidth;
    drawHeight = drawWidth / sourceRatio;
  }
  // Request enough real map pixels for the page instead of enlarging a
  // screen-resolution crop. MapView applies the final GPU-safe canvas cap.
  return clamp(Math.max(drawWidth / selection.width, drawHeight / selection.height), 1, 8);
}

function drawNorthArrow(context, x, y, size, bearing = 0) {
  context.save();
  context.translate(x, y);
  context.rotate((-Number(bearing || 0) * Math.PI) / 180);
  context.fillStyle = '#111827';
  context.font = `700 ${Math.round(size * 0.34)}px system-ui, sans-serif`;
  context.textAlign = 'center';
  context.fillText('N', 0, -size * 0.48);
  context.beginPath();
  context.moveTo(0, -size * 0.32);
  context.lineTo(size * 0.24, size * 0.34);
  context.lineTo(0, size * 0.17);
  context.lineTo(-size * 0.24, size * 0.34);
  context.closePath();
  context.fill();
  context.restore();
}

function drawScaleBar(context, x, y, width, height, label) {
  context.save();
  context.font = `600 ${Math.max(10, Math.round(height * 0.8))}px system-ui, sans-serif`;
  context.textAlign = 'left';
  context.fillStyle = '#111827';
  context.fillText(label || 'Scale', x, y - height * 0.45);
  const segment = width / 4;
  for (let index = 0; index < 4; index += 1) {
    context.fillStyle = index % 2 === 0 ? '#111827' : '#ffffff';
    context.fillRect(x + (segment * index), y, segment, height);
    context.strokeStyle = '#111827';
    context.strokeRect(x + (segment * index), y, segment, height);
  }
  context.restore();
}

function drawLegend(context, x, y, width, height, metadata) {
  const gradient = context.createLinearGradient(x, y, x + width, y);
  const palette = Array.isArray(metadata.legendPalette) ? metadata.legendPalette : [];
  if (palette.length >= 2) {
    palette.forEach((color, index) => {
      gradient.addColorStop(index / (palette.length - 1), `rgb(${color[0]}, ${color[1]}, ${color[2]})`);
    });
  } else if (metadata.analysisMode === 'hotspot') {
    gradient.addColorStop(0, '#313695');
    gradient.addColorStop(0.5, '#f7f7f7');
    gradient.addColorStop(1, '#a50026');
  } else {
    gradient.addColorStop(0, '#00224e');
    gradient.addColorStop(0.5, '#6ca97a');
    gradient.addColorStop(1, '#eecd54');
  }
  context.fillStyle = 'rgba(255, 255, 255, 0.92)';
  context.fillRect(x - height, y - height * 2.7, width + height * 2, height * 5.2);
  context.fillStyle = '#111827';
  context.font = `700 ${Math.max(11, Math.round(height * 0.95))}px system-ui, sans-serif`;
  context.fillText(metadata.variableLabel || 'Map values', x, y - height * 1.15);
  context.fillStyle = gradient;
  context.fillRect(x, y, width, height);
  context.strokeStyle = '#374151';
  context.strokeRect(x, y, width, height);
  context.font = `500 ${Math.max(9, Math.round(height * 0.72))}px system-ui, sans-serif`;
  context.fillStyle = '#111827';
  const range = metadata.legendRange || { min: 0, max: 1 };
  context.textAlign = 'left';
  context.fillText(Number(range.min).toFixed(2), x, y + height * 2.1);
  context.textAlign = 'right';
  context.fillText(Number(range.max).toFixed(2), x + width, y + height * 2.1);
  context.textAlign = 'left';
}

async function composeLayout(sourceCanvas, settings, metadata, preview = false) {
  const metrics = getLayoutMetrics(settings, preview);
  const expressionVariables = buildExpressionVariables(settings, metadata);
  const resolvedTitle = resolveTemplate(settings.title, expressionVariables);
  const resolvedSubtitle = resolveTemplate(settings.subtitle, expressionVariables);
  const canvas = document.createElement('canvas');
  canvas.width = metrics.pageWidth;
  canvas.height = metrics.pageHeight;
  const context = canvas.getContext('2d', { alpha: false });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  const { pxPerMm, margin, headerHeight, footerHeight } = metrics;
  const mapX = margin;
  const mapY = margin + headerHeight;
  const mapWidth = Math.max(1, canvas.width - (margin * 2));
  const mapHeight = Math.max(1, canvas.height - mapY - margin - footerHeight);

  context.fillStyle = settings.background;
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.fillStyle = '#111827';
  context.textAlign = 'left';
  if (resolvedTitle) {
    context.font = `700 ${Math.round(8 * pxPerMm)}px system-ui, sans-serif`;
    context.fillText(resolvedTitle, margin, margin + (7 * pxPerMm));
  }
  if (resolvedSubtitle) {
    context.fillStyle = '#4b5563';
    context.font = `500 ${Math.round(3.5 * pxPerMm)}px system-ui, sans-serif`;
    context.fillText(resolvedSubtitle, margin, margin + (13 * pxPerMm));
  }

  const sourceRatio = sourceCanvas.width / sourceCanvas.height;
  const targetRatio = mapWidth / mapHeight;
  let drawWidth;
  let drawHeight;
  if ((settings.fit === 'cover' && sourceRatio > targetRatio)
    || (settings.fit === 'contain' && sourceRatio < targetRatio)) {
    drawHeight = mapHeight;
    drawWidth = drawHeight * sourceRatio;
  } else {
    drawWidth = mapWidth;
    drawHeight = drawWidth / sourceRatio;
  }
  const drawX = mapX + ((mapWidth - drawWidth) / 2);
  const drawY = mapY + ((mapHeight - drawHeight) / 2);
  context.save();
  context.beginPath();
  context.rect(mapX, mapY, mapWidth, mapHeight);
  context.clip();
  context.drawImage(sourceCanvas, drawX, drawY, drawWidth, drawHeight);
  context.restore();

  const itemUnit = Math.max(1, pxPerMm);
  if (settings.frame) {
    context.strokeStyle = '#111827';
    context.lineWidth = Math.max(1, itemUnit * 0.45);
    context.strokeRect(mapX, mapY, mapWidth, mapHeight);
  }
  if (settings.northArrow) {
    drawNorthArrow(context, mapX + mapWidth - (13 * itemUnit), mapY + (16 * itemUnit), 10 * itemUnit, metadata.bearing);
  }
  if (settings.scaleBar && metadata.scaleInfo?.fraction > 0) {
    drawScaleBar(
      context,
      Math.max(mapX, drawX) + (7 * itemUnit),
      mapY + mapHeight - (10 * itemUnit),
      drawWidth * metadata.scaleInfo.fraction,
      2.4 * itemUnit,
      metadata.scaleInfo.label,
    );
  }
  if (settings.legend) {
    drawLegend(
      context,
      mapX + mapWidth - (60 * itemUnit),
      mapY + mapHeight - (13 * itemUnit),
      48 * itemUnit,
      2.5 * itemUnit,
      metadata,
    );
  }

  context.fillStyle = '#4b5563';
  context.font = `500 ${Math.max(10, Math.round(2.7 * itemUnit))}px system-ui, sans-serif`;
  const footerY = canvas.height - margin + (2 * itemUnit);
  if (settings.coordinates && metadata.boundsText) {
    context.textAlign = 'left';
    context.fillText(metadata.boundsText, margin, footerY);
  }
  if (settings.timestamp) {
    context.textAlign = 'right';
    context.fillText(`Created ${formatDisplayDateTime(new Date())}`, canvas.width - margin, footerY);
  }
  return canvas;
}

async function composeMetadataPage(settings, metadata) {
  const metrics = getLayoutMetrics(settings, false);
  const canvas = document.createElement('canvas');
  canvas.width = metrics.pageWidth;
  canvas.height = metrics.pageHeight;
  const context = canvas.getContext('2d', { alpha: false });
  const variables = buildExpressionVariables(settings, metadata);
  const unit = metrics.pxPerMm;
  const margin = metrics.margin;
  context.fillStyle = settings.background;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#111827';
  context.font = `700 ${Math.round(8 * unit)}px system-ui, sans-serif`;
  context.fillText(resolveTemplate('[% region %] — Data summary', variables), margin, margin + (8 * unit));
  context.fillStyle = '#4b5563';
  context.font = `500 ${Math.round(3.4 * unit)}px system-ui, sans-serif`;
  context.fillText('Automated report section generated with the map layout', margin, margin + (15 * unit));

  const rows = [
    ['Region', variables.region],
    ['Dataset variable', variables.variable],
    ['Observation date', variables.date || 'Not specified'],
    ['Rendered observations', variables.points],
    ['Displayed value range', `${variables.min} to ${variables.max}`],
    ['Map scale', variables.scale || 'Calculated from selected extent'],
    ['Geographic extent', metadata.boundsText || 'Current atlas extent'],
    ['Output specification', `${settings.pageSize.toUpperCase()} · ${settings.orientation} · ${settings.dpi} DPI`],
    ['Author', variables.author || 'Not specified'],
    ['Organization', variables.organization || 'Not specified'],
  ];
  let y = margin + (30 * unit);
  rows.forEach(([label, value], index) => {
    const rowHeight = 13 * unit;
    if (index % 2 === 0) {
      context.fillStyle = '#f3f6f8';
      context.fillRect(margin, y - (7 * unit), canvas.width - (margin * 2), rowHeight);
    }
    context.fillStyle = '#52606d';
    context.font = `700 ${Math.round(3.2 * unit)}px system-ui, sans-serif`;
    context.fillText(label, margin + (4 * unit), y);
    context.fillStyle = '#111827';
    context.font = `500 ${Math.round(3.2 * unit)}px system-ui, sans-serif`;
    context.fillText(String(value), margin + (55 * unit), y);
    y += rowHeight;
  });
  context.strokeStyle = '#1f2937';
  context.lineWidth = Math.max(1, 0.4 * unit);
  context.strokeRect(margin, margin, canvas.width - (margin * 2), canvas.height - (margin * 2));
  context.fillStyle = '#6b7280';
  context.font = `500 ${Math.round(2.7 * unit)}px system-ui, sans-serif`;
  context.fillText(`Generated ${formatDisplayDateTime(new Date())} · Page ${metadata.page || 1} of ${metadata.pages || 1}`, margin, canvas.height - margin + (2 * unit));
  return canvas;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function canvasToBlob(canvas, type, quality = 0.94) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The browser could not encode this map image.'));
    }, type, quality);
  });
}

function SettingsGroup({ title, children, open = false }) {
  return (
    <details className="snapshot-settings-group" open={open}>
      <summary>{title}<span aria-hidden="true">+</span></summary>
      <div className="snapshot-settings-body">{children}</div>
    </details>
  );
}

export default function SnapshotLayout({
  mapElement,
  onClose,
  prepareCapture,
  renderDataOverlay,
  metadata,
}) {
  const [mapRect, setMapRect] = useState(null);
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);
  const [selection, setSelection] = useState(null);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [templates, setTemplates] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(TEMPLATE_STORAGE_KEY) || '{}');
    } catch (storageError) {
      return {};
    }
  });
  const [templateName, setTemplateName] = useState('Research layout');
  const [atlasEnabled, setAtlasEnabled] = useState(false);
  const [atlasSelectedIds, setAtlasSelectedIds] = useState([]);
  const [previewUrl, setPreviewUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const surfaceRef = useRef(null);

  const measureMap = useCallback(() => {
    if (!mapElement?.isConnected) return;
    const bounds = mapElement.getBoundingClientRect();
    setMapRect({ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height });
  }, [mapElement]);

  useEffect(() => {
    measureMap();
    window.addEventListener('resize', measureMap);
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measureMap) : null;
    if (observer && mapElement) observer.observe(mapElement);
    return () => {
      window.removeEventListener('resize', measureMap);
      observer?.disconnect();
    };
  }, [mapElement, measureMap]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const updateSetting = (key, value) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const atlasRegions = useMemo(
    () => (metadata?.atlasRegions || []).filter((region) => region?.bounds).slice(0, 100),
    [metadata]
  );

  const selectedAtlasRegions = useMemo(() => {
    const selected = new Set(atlasSelectedIds);
    return atlasRegions.filter((region) => selected.has(region.id)).slice(0, MAX_ATLAS_PAGES);
  }, [atlasRegions, atlasSelectedIds]);

  const persistTemplates = (nextTemplates) => {
    setTemplates(nextTemplates);
    localStorage.setItem(TEMPLATE_STORAGE_KEY, JSON.stringify(nextTemplates));
  };

  const handleSaveTemplate = () => {
    const name = templateName.trim();
    if (!name) {
      setError('Enter a template name first.');
      return;
    }
    persistTemplates({ ...templates, [name]: settings });
    setError('');
  };

  const handleLoadTemplate = (name) => {
    if (!templates[name]) return;
    setSettings({ ...DEFAULT_SETTINGS, ...templates[name] });
    setTemplateName(name);
    setError('');
  };

  const handleDeleteTemplate = () => {
    if (!templates[templateName]) return;
    const nextTemplates = { ...templates };
    delete nextTemplates[templateName];
    persistTemplates(nextTemplates);
  };

  const selectionStyle = useMemo(() => {
    const rect = selection || (dragStart && dragEnd ? normalizeRect(dragStart, dragEnd) : null);
    if (!rect) return null;
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }, [selection, dragStart, dragEnd]);

  const buildBoundsText = useCallback((rect = selection) => {
    if (!rect || !mapRect || !metadata?.unproject) return '';
    try {
      const topLeft = metadata.unproject([
        rect.left - mapRect.left,
        rect.top - mapRect.top,
      ]);
      const bottomRight = metadata.unproject([
        rect.left + rect.width - mapRect.left,
        rect.top + rect.height - mapRect.top,
      ]);
      const minLatitude = Math.min(topLeft[1], bottomRight[1]);
      const maxLatitude = Math.max(topLeft[1], bottomRight[1]);
      const minLongitude = Math.min(topLeft[0], bottomRight[0]);
      const maxLongitude = Math.max(topLeft[0], bottomRight[0]);
      return `${formatCoordinate(minLatitude, 'N', 'S')}–${formatCoordinate(maxLatitude, 'N', 'S')} · ${formatCoordinate(minLongitude, 'E', 'W')}–${formatCoordinate(maxLongitude, 'E', 'W')}`;
    } catch (captureError) {
      return '';
    }
  }, [selection, mapRect, metadata]);

  const buildScaleInfo = useCallback((rect = selection) => {
    if (!rect || !mapRect || !metadata?.unproject) return null;
    try {
      const sampleY = rect.top + (rect.height * 0.82) - mapRect.top;
      const left = metadata.unproject([rect.left - mapRect.left, sampleY]);
      const right = metadata.unproject([rect.left + rect.width - mapRect.left, sampleY]);
      const totalMeters = haversineDistance(left, right);
      const scaleMeters = getNiceScaleDistance(totalMeters * 0.24);
      if (!scaleMeters || !totalMeters) return null;
      return {
        fraction: scaleMeters / totalMeters,
        meters: scaleMeters,
        label: scaleMeters >= 1000
          ? `${Number((scaleMeters / 1000).toPrecision(4))} km`
          : `${Math.round(scaleMeters)} m`,
      };
    } catch (scaleError) {
      return null;
    }
  }, [selection, mapRect, metadata]);

  const captureRegion = useCallback(async (rect, activeSettings, captureScale) => {
    if (!rect) throw new Error('Draw a map region first.');
    const restoreMap = await prepareCapture?.(captureScale, activeSettings.background);
    try {
      await nextFrame();
      return await captureCanvases(
        mapElement,
        rect,
        captureScale,
        (context, selectedRect, scale) => {
          renderDataOverlay?.(context, selectedRect, scale);
          drawCoordinateGrid(context, selectedRect, scale, metadata, mapRect, activeSettings);
        },
        activeSettings.background,
      );
    } finally {
      restoreMap?.();
    }
  }, [mapElement, prepareCapture, renderDataOverlay, metadata, mapRect]);

  const captureSource = useCallback(async (captureScale = 1) => (
    captureRegion(selection, settings, captureScale)
  ), [captureRegion, selection, settings]);

  const refreshPreview = useCallback(async (selectedRect = selection, nextSettings = settings) => {
    if (!selectedRect) return;
    setBusy(true);
    setError('');
    try {
      const captureScale = getCaptureScale(nextSettings, selectedRect, true);
      const source = await captureRegion(selectedRect, nextSettings, captureScale);
      const previewCanvas = await composeLayout(source, nextSettings, {
        ...metadata,
        boundsText: buildBoundsText(selectedRect),
        scaleInfo: buildScaleInfo(selectedRect),
      }, true);
      const blob = await canvasToBlob(previewCanvas, 'image/png');
      const nextUrl = URL.createObjectURL(blob);
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return nextUrl;
      });
    } catch (captureError) {
      setError(captureError.message || 'Unable to preview the selected map area.');
    } finally {
      setBusy(false);
    }
  }, [selection, settings, metadata, buildBoundsText, buildScaleInfo, captureRegion]);

  const handlePointerDown = (event) => {
    if (!mapRect || selection) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const point = {
      x: clamp(event.clientX, mapRect.left, mapRect.left + mapRect.width),
      y: clamp(event.clientY, mapRect.top, mapRect.top + mapRect.height),
    };
    setDragStart(point);
    setDragEnd(point);
    setError('');
  };

  const handlePointerMove = (event) => {
    if (!dragStart || !mapRect || selection) return;
    setDragEnd({
      x: clamp(event.clientX, mapRect.left, mapRect.left + mapRect.width),
      y: clamp(event.clientY, mapRect.top, mapRect.top + mapRect.height),
    });
  };

  const handlePointerUp = async (event) => {
    if (!dragStart || !dragEnd || selection) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const rect = normalizeRect(dragStart, dragEnd);
    setDragStart(null);
    setDragEnd(null);
    if (rect.width < 32 || rect.height < 32) {
      setError('Select a larger map area (at least 32 × 32 pixels).');
      return;
    }
    setSelection(rect);
    await refreshPreview(rect, settings);
  };

  const handleRedraw = () => {
    setSelection(null);
    setDragStart(null);
    setDragEnd(null);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return '';
    });
    setError('');
  };

  const handleExport = async () => {
    if (atlasEnabled && selectedAtlasRegions.length) {
      setError('Atlas output is multi-page. Use Print / PDF to export the complete atlas.');
      return;
    }
    setBusy(true);
    setProgress('Rendering image');
    setError('');
    try {
      const pageMetadata = {
        ...metadata,
        boundsText: buildBoundsText(),
        scaleInfo: buildScaleInfo(),
      };
      const source = await captureSource(getCaptureScale(settings, selection));
      const output = await composeLayout(source, settings, pageMetadata);
      const filename = safeFilename(resolveTemplate(
        settings.title,
        buildExpressionVariables(settings, pageMetadata),
      ));
      if (settings.format === 'svg') {
        const png = output.toDataURL('image/png');
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${output.width}" height="${output.height}" viewBox="0 0 ${output.width} ${output.height}"><image width="100%" height="100%" href="${png}"/></svg>`;
        downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${filename}.svg`);
      } else {
        const mime = settings.format === 'jpeg' ? 'image/jpeg' : 'image/png';
        const blob = await canvasToBlob(output, mime, 0.98);
        downloadBlob(blob, `${filename}.${settings.format === 'jpeg' ? 'jpg' : 'png'}`);
      }
    } catch (captureError) {
      setError(captureError.message || 'Unable to export this map layout.');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const handlePrint = async () => {
    const printWindow = window.open('', '_blank', 'width=1100,height=800');
    if (!printWindow) {
      setError('Allow pop-ups to open the system print / Save as PDF dialog.');
      return;
    }
    printWindow.opener = null;
    setBusy(true);
    setProgress('Preparing pages');
    setError('');
    try {
      const atlasPages = atlasEnabled ? selectedAtlasRegions : [];
      if (atlasEnabled && atlasPages.length === 0) {
        throw new Error('Select at least one atlas region.');
      }
      const logicalPageCount = Math.max(1, atlasPages.length);
      const totalOutputPages = logicalPageCount * (settings.includeMetadataPage ? 2 : 1);
      const pageImages = [];
      const renderPage = async (rect, pageMetadata) => {
        const captureScale = getCaptureScale(settings, rect);
        const source = await captureRegion(rect, settings, captureScale);
        const resolvedMetadata = {
          ...metadata,
          ...pageMetadata,
          boundsText: buildBoundsText(rect),
          scaleInfo: buildScaleInfo(rect),
        };
        const output = await composeLayout(source, settings, resolvedMetadata);
        pageImages.push(output.toDataURL('image/png'));
        if (settings.includeMetadataPage) {
          const metadataPage = await composeMetadataPage(settings, {
            ...resolvedMetadata,
            page: pageImages.length + 1,
            pages: totalOutputPages,
          });
          pageImages.push(metadataPage.toDataURL('image/png'));
        }
      };

      if (atlasPages.length) {
        const atlasRect = {
          left: mapRect.left,
          top: mapRect.top,
          width: mapRect.width,
          height: mapRect.height,
        };
        for (let index = 0; index < atlasPages.length; index += 1) {
          const region = atlasPages[index];
          setProgress(`Atlas ${index + 1} of ${atlasPages.length}: ${region.label}`);
          await metadata.focusAtlasRegion?.(region);
          await renderPage(atlasRect, {
            region: region.label,
            page: (index * (settings.includeMetadataPage ? 2 : 1)) + 1,
            pages: totalOutputPages,
          });
        }
      } else {
        await renderPage(selection, {
          region: metadata.region || 'Current selection',
          page: 1,
          pages: totalOutputPages,
        });
      }

      const { widthMm, heightMm } = getPageDimensions(settings);
      printWindow.onload = () => {
        printWindow.focus();
        printWindow.print();
      };
      const imageMarkup = pageImages.map((image, index) => (
        `<img class="page${index === pageImages.length - 1 ? ' last' : ''}" src="${image}" alt="Map report page ${index + 1}">`
      )).join('');
      printWindow.document.write(`<!doctype html><html><head><title>${resolveTemplate(settings.title, buildExpressionVariables(settings, metadata))}</title><style>@page{size:${widthMm}mm ${heightMm}mm;margin:0}html,body{margin:0;background:#fff}.page{display:block;width:${widthMm}mm;height:${heightMm}mm;break-after:page;page-break-after:always}.page.last{break-after:auto;page-break-after:auto}</style></head><body>${imageMarkup}</body></html>`);
      printWindow.document.close();
    } catch (captureError) {
      printWindow.close();
      setError(captureError.message || 'Unable to prepare this map for printing.');
    } finally {
      await metadata.restoreAtlasView?.();
      setBusy(false);
      setProgress('');
    }
  };

  const portal = (
    <div className="snapshot-layout" role="dialog" aria-modal="true" aria-label="Map snapshot and print layout">
      {!selectionStyle && <div className="snapshot-global-scrim" />}
      {mapRect && (
        <div
          ref={surfaceRef}
          className={`snapshot-capture-surface ${selection ? 'has-selection' : ''}`}
          style={{ left: mapRect.left, top: mapRect.top, width: mapRect.width, height: mapRect.height }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        />
      )}
      {selectionStyle && (
        <div className="snapshot-selection-window" style={selectionStyle}>
          <span className="snapshot-corner corner-nw" />
          <span className="snapshot-corner corner-ne" />
          <span className="snapshot-corner corner-sw" />
          <span className="snapshot-corner corner-se" />
          {selection && <span className="snapshot-selection-size">{Math.round(selection.width)} × {Math.round(selection.height)} px</span>}
        </div>
      )}

      <div className="snapshot-topbar">
        <div>
          <strong>{selection ? 'Map Print Layout' : 'Select snapshot area'}</strong>
          <span>{selection ? 'Adjust the composition, then export or print.' : 'Drag a box over the map. The clear area is your snapshot.'}</span>
        </div>
        <div className="snapshot-top-actions">
          {selection && <button type="button" onClick={handleRedraw}>Redraw area</button>}
          <button type="button" className="snapshot-close" onClick={onClose}>Cancel <kbd>Esc</kbd></button>
        </div>
      </div>

      {selection && (
        <aside className="snapshot-panel" onPointerDown={(event) => event.stopPropagation()}>
          <div className="snapshot-panel-heading">
            <div>
              <span className="snapshot-eyebrow">Publication tools</span>
              <h2>Print layout</h2>
            </div>
            <span className="snapshot-qgis-badge">QGIS-style</span>
          </div>

          <div className="snapshot-preview" aria-label="Layout preview">
            {previewUrl ? <img src={previewUrl} alt="Map print layout preview" /> : <span>Preparing preview…</span>}
          </div>

          <div className="snapshot-rendering-note">
            <strong>Publication surface</strong>
            <span>Native grid cells · opaque values · boundaries above data</span>
          </div>

          <SettingsGroup title="Title & labels" open>
            <label>Map title<input value={settings.title} onChange={(event) => updateSetting('title', event.target.value)} /></label>
            <label>Subtitle<input value={settings.subtitle} onChange={(event) => updateSetting('subtitle', event.target.value)} /></label>
            <div className="snapshot-expression-help">
              Dynamic fields: <code>[% region %]</code> <code>[% variable %]</code> <code>[% date %]</code> <code>[% min %]</code> <code>[% max %]</code> <code>[% page %]</code>
            </div>
            <label>Layout variables<textarea rows="3" value={settings.customVariables} onChange={(event) => updateSetting('customVariables', event.target.value)} placeholder="author=Name&#10;organization=Institute" /></label>
          </SettingsGroup>

          <SettingsGroup title="Page & layout" open>
            <div className="snapshot-field-row">
              <label>Paper<select value={settings.pageSize} onChange={(event) => updateSetting('pageSize', event.target.value)}>{Object.entries(PAGE_SIZES).map(([value, page]) => <option key={value} value={value}>{page.label}</option>)}</select></label>
              <label>Orientation<select value={settings.orientation} onChange={(event) => updateSetting('orientation', event.target.value)}><option value="landscape">Landscape</option><option value="portrait">Portrait</option></select></label>
            </div>
            <div className="snapshot-field-row">
              <label>Map fit<select value={settings.fit} onChange={(event) => updateSetting('fit', event.target.value)}><option value="contain">Fit inside</option><option value="cover">Fill frame</option></select></label>
              <label>Margin (mm)<input type="number" min="4" max="35" value={settings.margin} onChange={(event) => updateSetting('margin', clamp(Number(event.target.value), 4, 35))} /></label>
            </div>
            <label className="snapshot-color-field">Page background<input type="color" value={settings.background} onChange={(event) => updateSetting('background', event.target.value)} /></label>
          </SettingsGroup>

          <SettingsGroup title="Map elements" open>
            <div className="snapshot-check-grid">
              {[['legend', 'Legend'], ['northArrow', 'North arrow'], ['scaleBar', 'Scale bar'], ['coordinates', 'Coordinates'], ['timestamp', 'Timestamp'], ['frame', 'Map frame']].map(([key, label]) => (
                <label key={key} className="snapshot-check"><input type="checkbox" checked={settings[key]} onChange={(event) => updateSetting(key, event.target.checked)} /><span>{label}</span></label>
              ))}
            </div>
            <label className="snapshot-check"><input type="checkbox" checked={settings.coordinateGrid} onChange={(event) => updateSetting('coordinateGrid', event.target.checked)} /><span>Coordinate grid / graticule</span></label>
            {settings.coordinateGrid && (
              <div className="snapshot-field-row">
                <label>Interval (degrees)<input value={settings.gridInterval} onChange={(event) => updateSetting('gridInterval', event.target.value)} placeholder="auto" /></label>
                <label>Grid style<select value={settings.gridStyle} onChange={(event) => updateSetting('gridStyle', event.target.value)}><option value="lines">Solid lines</option><option value="crosses">Dashed crosses</option></select></label>
              </div>
            )}
            <label className="snapshot-check"><input type="checkbox" checked={settings.includeMetadataPage} onChange={(event) => updateSetting('includeMetadataPage', event.target.checked)} /><span>Report metadata page</span></label>
          </SettingsGroup>

          <SettingsGroup title="Templates & variables">
            <label>Template name<input value={templateName} onChange={(event) => setTemplateName(event.target.value)} /></label>
            <div className="snapshot-template-actions">
              <button type="button" onClick={handleSaveTemplate}>Save</button>
              <button type="button" onClick={handleDeleteTemplate} disabled={!templates[templateName]}>Delete</button>
            </div>
            {Object.keys(templates).length > 0 && (
              <label>Saved templates<select value={templates[templateName] ? templateName : ''} onChange={(event) => handleLoadTemplate(event.target.value)}><option value="">Choose template…</option>{Object.keys(templates).sort().map((name) => <option key={name} value={name}>{name}</option>)}</select></label>
            )}
          </SettingsGroup>

          <SettingsGroup title="Atlas & batch PDF">
            <label className="snapshot-check"><input type="checkbox" checked={atlasEnabled} onChange={(event) => {
              const enabled = event.target.checked;
              setAtlasEnabled(enabled);
              if (enabled && atlasSelectedIds.length === 0) {
                setAtlasSelectedIds(atlasRegions.slice(0, 3).map((region) => region.id));
              }
            }} /><span>Generate one page per region</span></label>
            {atlasEnabled && (
              <>
                <div className="snapshot-atlas-toolbar">
                  <span>{selectedAtlasRegions.length}/{MAX_ATLAS_PAGES} pages</span>
                  <button type="button" onClick={() => setAtlasSelectedIds(atlasRegions.slice(0, MAX_ATLAS_PAGES).map((region) => region.id))}>First {MAX_ATLAS_PAGES}</button>
                  <button type="button" onClick={() => setAtlasSelectedIds([])}>Clear</button>
                </div>
                <div className="snapshot-atlas-list">
                  {atlasRegions.map((region) => {
                    const checked = atlasSelectedIds.includes(region.id);
                    const atLimit = !checked && atlasSelectedIds.length >= MAX_ATLAS_PAGES;
                    return <label key={region.id} className="snapshot-check"><input type="checkbox" checked={checked} disabled={atLimit} onChange={(event) => setAtlasSelectedIds((current) => event.target.checked ? [...current, region.id].slice(0, MAX_ATLAS_PAGES) : current.filter((id) => id !== region.id))} /><span>{region.label}</span></label>;
                  })}
                </div>
                <div className="snapshot-expression-help">Atlas output uses Print / PDF and supports <code>[% region %]</code>, <code>[% page %]</code>, and <code>[% pages %]</code>.</div>
              </>
            )}
          </SettingsGroup>

          <SettingsGroup title="Export settings" open>
            <div className="snapshot-field-row">
              <label>Format<select value={settings.format} onChange={(event) => updateSetting('format', event.target.value)}><option value="png">PNG image</option><option value="jpeg">JPEG image</option><option value="svg">SVG wrapper</option></select></label>
              <label>Resolution<select value={settings.dpi} onChange={(event) => updateSetting('dpi', Number(event.target.value))}><option value="96">96 DPI · Screen</option><option value="150">150 DPI · Print</option><option value="300">300 DPI · Publication</option></select></label>
            </div>
          </SettingsGroup>

          {error && <div className="snapshot-error" role="alert">{error}</div>}
          <div className="snapshot-panel-actions">
            {progress && <div className="snapshot-progress">{progress}</div>}
            <button type="button" className="snapshot-preview-btn" disabled={busy} onClick={() => refreshPreview()}>{busy ? 'Rendering…' : 'Refresh preview'}</button>
            <button type="button" className="snapshot-print-btn" disabled={busy} onClick={handlePrint}>{atlasEnabled ? `Print Atlas (${selectedAtlasRegions.length}) / PDF` : 'Print / PDF'}</button>
            <button type="button" className="snapshot-export-btn" disabled={busy || (atlasEnabled && selectedAtlasRegions.length > 0)} onClick={handleExport}>{busy ? 'Exporting…' : `Export ${settings.format.toUpperCase()}`}</button>
          </div>
        </aside>
      )}

      {!selection && error && <div className="snapshot-floating-error" role="alert">{error}</div>}
    </div>
  );

  return createPortal(portal, document.body);
}
