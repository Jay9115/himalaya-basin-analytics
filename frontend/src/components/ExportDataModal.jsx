import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import apiService from '../services/api';
import './ExportDataModal.css';

const formatVariableLabel = (name) => {
  if (!name) return '';
  if (name === 'elevation_m') return 'DEM Elevation (m)';
  const parts = name.split('_');
  if (parts.length === 1) return name.charAt(0).toUpperCase() + name.slice(1);
  const unit = parts[parts.length - 1];
  const label = parts.slice(0, -1).join(' ');
  return `${label.replace(/\b\w/g, (c) => c.toUpperCase())} (${unit})`;
};

const toInputDate = (isoDate) => {
  if (!isoDate) return '';
  // Accept YYYY-MM-DD directly
  if (/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return isoDate;
  try {
    const d = new Date(isoDate);
    return d.toISOString().slice(0, 10);
  } catch {
    return '';
  }
};

const POLL_INTERVAL_MS = 1500;

function ExportDataModal({
  open,
  onClose,
  variables = [],
  datasets = [],
  datasetId = '',
  datasetLabel = '',
  yearRange = null,
  dates = [],
  selectedSubregionId = '',
  selectedSubregionLabel = '',
  roiPolygon = null,
  elevRange = { min: 500, max: 9000 },
}) {
  // ── State ─────────────────────────────────────────────────────
  const [allDatasets, setAllDatasets] = useState(datasets || []);
  const [currentDatasetId, setCurrentDatasetId] = useState(datasetId || '');
  const [datasetMetaCache, setDatasetMetaCache] = useState({});
  const [currentVariables, setCurrentVariables] = useState(variables || []);
  const [currentDates, setCurrentDates] = useState(dates || []);
  const [loadingDataset, setLoadingDataset] = useState(false);
  const [customVarsMap, setCustomVarsMap] = useState({});
  const [customVarInput, setCustomVarInput] = useState('');

  // selectedItems: array of { id, datasetId, variable, label, datasetLabel, isCustom }
  const [selectedItems, setSelectedItems] = useState([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [exportTemporal, setExportTemporal] = useState(true);
  const [exportSpatial, setExportSpatial] = useState(false);
  const [spatialFormat, setSpatialFormat] = useState('geotiff');
  const [spatialAggregation, setSpatialAggregation] = useState('daily');
  const [destinationPath, setDestinationPath] = useState('');
  const [dirHandle, setDirHandle] = useState(null);
  const dirHandleRef = useRef(null);
  dirHandleRef.current = dirHandle;

  const [directSaveStatus, setDirectSaveStatus] = useState({
    saving: false,
    currentFile: '',
    count: 0,
    total: 0,
    done: false,
    error: '',
  });
  const directSaveTriggeredRef = useRef(false);

  const [jobId, setJobId] = useState(null);
  const [jobStatus, setJobStatus] = useState(null);
  const [error, setError] = useState('');
  const pollRef = useRef(null);
  const closedRef = useRef(false);

  const supportsDirPicker = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  // ── Helpers & Derived ──────────────────────────────────────────
  const getDatasetLabel = useCallback((dId) => {
    const ds = allDatasets.find((d) => d.id === dId);
    if (ds?.label) return ds.label;
    if (dId === datasetId && datasetLabel) return datasetLabel;
    return dId || 'Dataset';
  }, [allDatasets, datasetId, datasetLabel]);

  const roiLabel = useMemo(() => {
    if (roiPolygon) return roiPolygon.name || roiPolygon.label || 'Custom ROI';
    if (selectedSubregionLabel) return selectedSubregionLabel;
    if (selectedSubregionId) return selectedSubregionId;
    return 'Full Basin';
  }, [roiPolygon, selectedSubregionLabel, selectedSubregionId]);

  const currentDatasetLabel = useMemo(
    () => getDatasetLabel(currentDatasetId),
    [getDatasetLabel, currentDatasetId]
  );

  const displayedVars = useMemo(() => {
    const list = [...currentVariables];
    const customForCurrent = customVarsMap[currentDatasetId] || [];
    for (const cv of customForCurrent) {
      if (!list.includes(cv)) list.push(cv);
    }
    return list;
  }, [currentVariables, customVarsMap, currentDatasetId]);

  const selectedItemIds = useMemo(
    () => new Set(selectedItems.map((i) => i.id)),
    [selectedItems]
  );

  const selectedDatasetIds = useMemo(
    () => new Set(selectedItems.map((i) => i.datasetId)),
    [selectedItems]
  );

  const selectedDatasetCount = selectedDatasetIds.size;

  const { minDate, maxDate } = useMemo(() => {
    const datesArr = [];
    if (selectedDatasetIds.size > 0) {
      for (const dsId of selectedDatasetIds) {
        if (datasetMetaCache[dsId]?.dates?.length) {
          datesArr.push(datasetMetaCache[dsId].dates[0]);
          datesArr.push(datasetMetaCache[dsId].dates[datasetMetaCache[dsId].dates.length - 1]);
        }
      }
    }
    if (datesArr.length === 0 && currentDates.length) {
      datesArr.push(currentDates[0]);
      datesArr.push(currentDates[currentDates.length - 1]);
    }
    if (datesArr.length === 0) return { minDate: '', maxDate: '' };
    datesArr.sort();
    return { minDate: datesArr[0], maxDate: datesArr[datesArr.length - 1] };
  }, [selectedDatasetIds, datasetMetaCache, currentDates]);

  const canExport = selectedItems.length > 0
    && startDate && endDate
    && (exportTemporal || exportSpatial)
    && !jobId;

  const isRunning = jobStatus?.status === 'running' || jobStatus?.status === 'queued';
  const isCompleted = jobStatus?.status === 'completed';
  const isFailed = jobStatus?.status === 'failed';

  // ── Init defaults ─────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    closedRef.current = false;
    const initialDs = datasetId || '';
    setCurrentDatasetId(initialDs);
    setCurrentVariables(variables || []);
    setCurrentDates(dates || []);
    setCustomVarsMap({});
    setCustomVarInput('');

    if (initialDs) {
      setDatasetMetaCache((prev) => ({
        ...prev,
        [initialDs]: { variables: variables || [], dates: dates || [] },
      }));
    }

    if (datasets && datasets.length) {
      setAllDatasets(datasets);
    }
    apiService.getDatasets().then((res) => {
      if (res?.datasets?.length) {
        setAllDatasets(res.datasets);
      }
    }).catch(() => {});

    // Pre-select first variable and set date range
    if (variables.length > 0 && selectedItems.length === 0) {
      const v0 = variables[0];
      setSelectedItems([
        {
          id: `${initialDs}:${v0}`,
          datasetId: initialDs,
          variable: v0,
          label: formatVariableLabel(v0),
          datasetLabel: datasetLabel || initialDs,
          isCustom: false,
        },
      ]);
    }
    const dStart = dates.length ? dates[0] : '';
    const dEnd = dates.length ? dates[dates.length - 1] : '';
    if (dStart) setStartDate(toInputDate(dStart));
    if (dEnd) setEndDate(toInputDate(dEnd));
  }, [open, datasetId, variables, dates, datasets, datasetLabel]);

  // ── Dataset Switch Handler ────────────────────────────────────
  const handleDatasetChange = useCallback(async (newId) => {
    if (!newId || newId === currentDatasetId) return;
    setCurrentDatasetId(newId);
    setError('');

    // Instant switch if metadata is already cached in-memory
    if (datasetMetaCache[newId]) {
      const cached = datasetMetaCache[newId];
      setCurrentVariables(cached.variables || []);
      setCurrentDates(cached.dates || []);
      return;
    }

    if (newId === datasetId) {
      // Current active dashboard dataset
      setCurrentVariables(variables || []);
      setCurrentDates(dates || []);
      setDatasetMetaCache((prev) => ({
        ...prev,
        [newId]: { variables: variables || [], dates: dates || [] },
      }));
      return;
    }

    setLoadingDataset(true);
    try {
      const [varsRes, datesRes] = await Promise.all([
        apiService.getAvailableVariables(newId),
        apiService.getAvailableDates(newId),
      ]);

      const fetchedVars = varsRes?.variables || [];
      const fetchedDates = datesRes?.dates || [];

      setCurrentVariables(fetchedVars);
      setCurrentDates(fetchedDates);
      setDatasetMetaCache((prev) => ({
        ...prev,
        [newId]: { variables: fetchedVars, dates: fetchedDates },
      }));
    } catch (err) {
      console.error('Failed to load dataset metadata:', err);
      const detail = err.response?.data?.detail || err.message || 'Failed to load dataset metadata';
      setError(`Could not load variables for dataset '${newId}': ${detail}`);
    } finally {
      setLoadingDataset(false);
    }
  }, [currentDatasetId, datasetId, variables, dates, datasetMetaCache]);

  // ── Variable toggle ───────────────────────────────────────────
  const toggleVar = useCallback((dsId, varName, isCustom = false) => {
    const id = `${dsId}:${varName}`;
    setSelectedItems((prev) => {
      const exists = prev.some((item) => item.id === id);
      if (exists) {
        return prev.filter((item) => item.id !== id);
      }
      const label = formatVariableLabel(varName);
      const dsLabel = getDatasetLabel(dsId);
      return [
        ...prev,
        {
          id,
          datasetId: dsId,
          variable: varName,
          label,
          datasetLabel: dsLabel,
          isCustom,
        },
      ];
    });
  }, [getDatasetLabel]);

  const selectAllVarsForCurrentDataset = useCallback(() => {
    const currentVars = displayedVars;
    if (currentVars.length === 0) return;

    const allCurrentSelected = currentVars.every((v) =>
      selectedItemIds.has(`${currentDatasetId}:${v}`)
    );

    if (allCurrentSelected) {
      // Deselect only variables belonging to currentDatasetId
      setSelectedItems((prev) =>
        prev.filter((item) => item.datasetId !== currentDatasetId)
      );
    } else {
      // Add all missing variables from currentDatasetId
      setSelectedItems((prev) => {
        const existingIds = new Set(prev.map((i) => i.id));
        const newItems = [...prev];
        const dsLabel = getDatasetLabel(currentDatasetId);
        const customForCurrent = customVarsMap[currentDatasetId] || [];

        for (const v of currentVars) {
          const id = `${currentDatasetId}:${v}`;
          if (!existingIds.has(id)) {
            newItems.push({
              id,
              datasetId: currentDatasetId,
              variable: v,
              label: formatVariableLabel(v),
              datasetLabel: dsLabel,
              isCustom: customForCurrent.includes(v),
            });
            existingIds.add(id);
          }
        }
        return newItems;
      });
    }
  }, [displayedVars, selectedItemIds, currentDatasetId, getDatasetLabel, customVarsMap]);

  // ── Custom Variable Handlers ──────────────────────────────────
  const handleAddCustomVar = useCallback(() => {
    const trimmed = customVarInput.trim();
    if (!trimmed) return;
    setCustomVarsMap((prev) => {
      const currentList = prev[currentDatasetId] || [];
      if (!currentList.includes(trimmed)) {
        return { ...prev, [currentDatasetId]: [...currentList, trimmed] };
      }
      return prev;
    });
    toggleVar(currentDatasetId, trimmed, true);
    setCustomVarInput('');
  }, [customVarInput, currentDatasetId, toggleVar]);

  const handleRemoveCustomVar = useCallback((dsId, varName) => {
    setCustomVarsMap((prev) => {
      const currentList = prev[dsId] || [];
      return { ...prev, [dsId]: currentList.filter((v) => v !== varName) };
    });
    setSelectedItems((prev) => prev.filter((i) => i.id !== `${dsId}:${varName}`));
  }, []);

  // ── Direct Folder Writing (Option A) ───────────────────────────
  const saveFilesToDirHandle = useCallback(async (targetJobId, handle) => {
    if (!handle || !targetJobId) return;
    setDirectSaveStatus({
      saving: true,
      currentFile: 'Cataloging generated files...',
      count: 0,
      total: 0,
      done: false,
      error: '',
    });
    try {
      const opts = { mode: 'readwrite' };
      if ((await handle.queryPermission(opts)) !== 'granted') {
        if ((await handle.requestPermission(opts)) !== 'granted') {
          throw new Error('Write permission to the selected folder was denied.');
        }
      }

      const catalog = await apiService.getExportFiles(targetJobId);
      const files = catalog.files || [];
      if (files.length === 0) {
        setDirectSaveStatus({
          saving: false,
          currentFile: '',
          count: 0,
          total: 0,
          done: true,
          error: '',
        });
        return;
      }

      setDirectSaveStatus({
        saving: true,
        currentFile: 'Writing files...',
        count: 0,
        total: files.length,
        done: false,
        error: '',
      });

      for (let i = 0; i < files.length; i++) {
        if (closedRef.current) break;
        const fileItem = files[i];
        setDirectSaveStatus((prev) => ({
          ...prev,
          currentFile: fileItem.path,
          count: i + 1,
        }));

        const parts = fileItem.path.split('/');
        const fileName = parts.pop();
        let currentDir = handle;
        for (const part of parts) {
          currentDir = await currentDir.getDirectoryHandle(part, { create: true });
        }

        const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        const fileUrl = apiService.getExportFileUrl(targetJobId, fileItem.path);
        const resp = await fetch(fileUrl);
        if (!resp.ok) {
          throw new Error(`Failed to download ${fileItem.path}: ${resp.statusText}`);
        }
        await resp.body.pipeTo(writable);
      }

      setDirectSaveStatus({
        saving: false,
        currentFile: '',
        count: files.length,
        total: files.length,
        done: true,
        error: '',
      });
    } catch (err) {
      console.error('Direct folder write error:', err);
      setDirectSaveStatus({
        saving: false,
        currentFile: '',
        count: 0,
        total: 0,
        done: false,
        error: `Direct folder write error: ${err.message}. You can still download the ZIP archive.`,
      });
    }
  }, []);

  // ── Browse folder picker ──────────────────────────────────────
  const handleBrowseFolder = useCallback(async () => {
    if (supportsDirPicker) {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        setDirHandle(handle);
        setDestinationPath(handle.name);
      } catch (err) {
        if (err.name !== 'AbortError') {
          console.warn('Folder picker error:', err);
        }
      }
    } else {
      alert(
        'Direct local folder browsing requires Google Chrome, Microsoft Edge, or a Chromium-based browser.\n\nIn other browsers, you can enter a destination folder path on this computer, or download the files as a ZIP archive.'
      );
    }
  }, [supportsDirPicker]);

  const handleClearFolder = useCallback(() => {
    setDirHandle(null);
    setDestinationPath('');
  }, []);

  // ── Polling ───────────────────────────────────────────────────
  const startPolling = useCallback((id) => {
    if (pollRef.current) clearInterval(pollRef.current);
    directSaveTriggeredRef.current = false;
    pollRef.current = setInterval(async () => {
      if (closedRef.current) {
        clearInterval(pollRef.current);
        return;
      }
      try {
        const status = await apiService.getExportStatus(id);
        setJobStatus(status);
        if (status.status === 'completed') {
          clearInterval(pollRef.current);
          if (dirHandleRef.current && !directSaveTriggeredRef.current) {
            directSaveTriggeredRef.current = true;
            saveFilesToDirHandle(id, dirHandleRef.current);
          }
        } else if (status.status === 'failed' || status.status === 'cancelled') {
          clearInterval(pollRef.current);
        }
      } catch (e) {
        // keep polling
      }
    }, POLL_INTERVAL_MS);
  }, [saveFilesToDirHandle]);

  // ── Start export ──────────────────────────────────────────────
  const handleExport = useCallback(async () => {
    setError('');
    setJobStatus(null);
    setDirectSaveStatus({ saving: false, currentFile: '', count: 0, total: 0, done: false, error: '' });
    directSaveTriggeredRef.current = false;

    const datasetVariables = {};
    const variablesList = [];
    for (const item of selectedItems) {
      if (!datasetVariables[item.datasetId]) {
        datasetVariables[item.datasetId] = [];
      }
      datasetVariables[item.datasetId].push(item.variable);
      variablesList.push(`${item.datasetId}:${item.variable}`);
    }

    const payload = {
      dataset: currentDatasetId || datasetId || undefined,
      variables: variablesList,
      dataset_variables: datasetVariables,
      start_date: startDate,
      end_date: endDate,
      year_start: undefined,
      year_end: undefined,
      elev_min: elevRange.min,
      elev_max: elevRange.max,
      subregion_id: roiPolygon ? undefined : (selectedSubregionId || undefined),
      aoi_geojson: roiPolygon
        ? JSON.stringify({
          type: 'Feature',
          properties: { id: roiPolygon.id, label: roiPolygon.name || roiPolygon.label || 'ROI' },
          geometry: roiPolygon.geometry,
        })
        : undefined,
      export_temporal_csv: exportTemporal,
      export_spatial_maps: exportSpatial,
      spatial_format: spatialFormat,
      spatial_aggregation: spatialAggregation,
      destination_folder: (!dirHandle && destinationPath.trim()) ? destinationPath.trim() : undefined,
    };

    try {
      const result = await apiService.startExport(payload);
      setJobId(result.job_id);
      setJobStatus({ status: 'queued', progress_percent: 0, message: 'Queued...' });
      startPolling(result.job_id);
    } catch (e) {
      const detail = e.response?.data?.detail || e.message || 'Export failed';
      setError(detail);
    }
  }, [
    selectedItems, currentDatasetId, datasetId, startDate, endDate,
    elevRange, selectedSubregionId, roiPolygon,
    exportTemporal, exportSpatial, spatialFormat, spatialAggregation,
    dirHandle, destinationPath, startPolling,
  ]);

  // ── Cancel ────────────────────────────────────────────────────
  const handleCancel = useCallback(async () => {
    if (!jobId) return;
    try {
      await apiService.cancelExport(jobId);
      if (pollRef.current) clearInterval(pollRef.current);
      setJobStatus((prev) => ({ ...prev, status: 'cancelled', message: 'Cancelled' }));
    } catch {
      // ignore
    }
  }, [jobId]);

  // ── Reset ─────────────────────────────────────────────────────
  const handleReset = useCallback(() => {
    setJobId(null);
    setJobStatus(null);
    setError('');
    setDirectSaveStatus({ saving: false, currentFile: '', count: 0, total: 0, done: false, error: '' });
    directSaveTriggeredRef.current = false;
    if (pollRef.current) clearInterval(pollRef.current);
  }, []);

  // ── Close handler ─────────────────────────────────────────────
  const handleClose = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    onClose();
  }, [onClose]);

  if (!open) return null;

  return (
    <div className="export-modal-backdrop" onClick={handleClose}>
      <div className="export-modal-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="export-modal-header">
          <svg className="export-modal-header-icon" viewBox="0 0 24 24">
            <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
          </svg>
          <span className="export-modal-title">Export Data</span>
          <button className="export-modal-close" onClick={handleClose} title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>

        <div className="export-modal-body">
          {/* ROI Info */}
          <div className="export-section">
            <div className="export-section-title">Region of Interest</div>
            <div>
              <span className="export-roi-chip">
                <svg viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z" /></svg>
                {roiLabel}
              </span>
            </div>
          </div>

          {/* Dataset Selection */}
          <div className="export-section">
            <div className="export-section-header">
              <span className="export-section-title">Datasets &amp; Sources</span>
              {selectedDatasetCount > 1 ? (
                <span className="export-cross-dataset-badge">
                  ✓ Cross-Dataset Export ({selectedDatasetCount} Datasets)
                </span>
              ) : currentDatasetId !== datasetId ? (
                <span className="export-alt-dataset-badge">
                  Alternate Dataset
                </span>
              ) : null}
            </div>

            {/* Quick Dataset Selector Tabs/Pills */}
            {allDatasets.length > 1 && (
              <div className="export-dataset-pills-row">
                {allDatasets.map((ds) => {
                  const isCur = ds.id === currentDatasetId;
                  const dsSelCount = selectedItems.filter((i) => i.datasetId === ds.id).length;
                  return (
                    <button
                      type="button"
                      key={ds.id}
                      className={`export-dataset-pill${isCur ? ' active' : ''}${dsSelCount > 0 ? ' has-selected' : ''}`}
                      onClick={() => handleDatasetChange(ds.id)}
                      disabled={isRunning || loadingDataset}
                      title={`Browse variables in ${ds.label || ds.id}`}
                    >
                      <span className="export-pill-label">{ds.label || ds.id}</span>
                      {ds.id === datasetId && (
                        <span className="export-pill-star" title="Active dashboard dataset">★</span>
                      )}
                      {dsSelCount > 0 && (
                        <span className="export-pill-count" title={`${dsSelCount} variables selected`}>
                          {dsSelCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="export-dataset-select-row">
              <select
                className="export-dataset-select"
                value={currentDatasetId}
                onChange={(e) => handleDatasetChange(e.target.value)}
                disabled={isRunning || loadingDataset}
              >
                {allDatasets.map((ds) => {
                  const dsSelCount = selectedItems.filter((i) => i.datasetId === ds.id).length;
                  return (
                    <option key={ds.id} value={ds.id}>
                      {ds.label || ds.id} {ds.id === datasetId ? '★ (Dashboard Active)' : ''} {dsSelCount > 0 ? `(${dsSelCount} selected)` : ''}
                    </option>
                  );
                })}
              </select>
              {loadingDataset && (
                <div className="export-dataset-spinner" title="Loading dataset variables & dates...">
                  <svg className="export-spin" viewBox="0 0 24 24" width="16" height="16">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" opacity="0.25" />
                    <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span>Loading metadata...</span>
                </div>
              )}
            </div>

            <div className="export-dataset-note">
              <span>💡</span>
              <span>
                Browsing variables in <strong>{currentDatasetLabel}</strong>. Variables selected across different datasets will all be exported together in this single job.
              </span>
            </div>
          </div>

          {/* Variable Selection */}
          <div className="export-section">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="export-section-title" style={{ flex: 1 }}>
                Variables in {currentDatasetLabel}
              </span>
              <button
                type="button"
                className="export-var-select-all"
                onClick={selectAllVarsForCurrentDataset}
                disabled={loadingDataset || displayedVars.length === 0}
              >
                {displayedVars.length > 0 &&
                displayedVars.every((v) => selectedItemIds.has(`${currentDatasetId}:${v}`))
                  ? 'Deselect Dataset Variables'
                  : 'Select All in Dataset'}
              </button>
            </div>

            {loadingDataset ? (
              <div className="export-vars-loading">
                <svg className="export-spin" viewBox="0 0 24 24" width="14" height="14">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" opacity="0.25" />
                  <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>Fetching dataset variables...</span>
              </div>
            ) : displayedVars.length === 0 ? (
              <div className="export-vars-empty">
                No indexed variables found for this dataset. You can manually enter variable names below.
              </div>
            ) : (
              <div className="export-var-grid">
                {displayedVars.map((v) => {
                  const isChecked = selectedItemIds.has(`${currentDatasetId}:${v}`);
                  const isCustom = (customVarsMap[currentDatasetId] || []).includes(v);
                  return (
                    <div key={v} className={`export-var-item${isCustom ? ' is-custom' : ''}`}>
                      <label className="export-var-label">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => toggleVar(currentDatasetId, v, isCustom)}
                        />
                        <span title={v}>{formatVariableLabel(v)}</span>
                      </label>
                      {isCustom && (
                        <button
                          type="button"
                          className="export-remove-var-btn"
                          onClick={() => handleRemoveCustomVar(currentDatasetId, v)}
                          title="Remove custom variable"
                        >
                          ×
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Input to add other / custom variables */}
            <div className="export-custom-var-row">
              <input
                type="text"
                className="export-custom-var-input"
                placeholder={`Add custom variable to ${currentDatasetLabel} (e.g. tmin, GMel, precip)...`}
                value={customVarInput}
                onChange={(e) => setCustomVarInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddCustomVar();
                  }
                }}
              />
              <button
                type="button"
                className="export-add-var-btn"
                onClick={handleAddCustomVar}
                disabled={!customVarInput.trim()}
                title="Add this variable to the selection"
              >
                + Add
              </button>
            </div>

            {/* Selected Variables Verification List */}
            <div className="export-selected-summary-box">
              <div className="export-selected-summary-header">
                <div className="export-selected-summary-title">
                  <span>Selected for Export</span>
                  <span className="export-selected-count-badge">{selectedItems.length}</span>
                  {selectedDatasetCount > 1 && (
                    <span className="export-selected-ds-count">({selectedDatasetCount} datasets)</span>
                  )}
                </div>
                {selectedItems.length > 0 && (
                  <button
                    type="button"
                    className="export-clear-selection-btn"
                    onClick={() => setSelectedItems([])}
                    title="Deselect all variables"
                  >
                    Clear All
                  </button>
                )}
              </div>

              {selectedItems.length === 0 ? (
                <div className="export-selected-empty-hint">
                  <span>⚠️</span>
                  <span>No variables selected. Check boxes above or switch datasets to add cross-dataset variables.</span>
                </div>
              ) : (
                <div className="export-selected-chips-wrap">
                  {selectedItems.map((item) => (
                    <span
                      key={item.id}
                      className={`export-selected-chip${item.isCustom ? ' is-custom' : ''}`}
                      title={`Dataset: ${item.datasetLabel} (${item.datasetId}) | Identifier: ${item.variable}`}
                    >
                      <span className="export-chip-dataset-tag">{item.datasetLabel || item.datasetId}</span>
                      <span className="export-chip-text">
                        {item.label}
                        {item.label !== item.variable && <span className="export-chip-code">({item.variable})</span>}
                      </span>
                      {item.isCustom && <span className="export-chip-type-tag">Custom</span>}
                      <button
                        type="button"
                        className="export-chip-remove-btn"
                        onClick={() => toggleVar(item.datasetId, item.variable, item.isCustom)}
                        title={`Remove ${item.variable} from export`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Temporal Filter */}
          <div className="export-section">
            <div className="export-section-title">Date Range</div>
            <div className="export-date-row">
              <input
                type="date"
                className="export-date-input"
                value={startDate}
                min={toInputDate(minDate)}
                max={toInputDate(maxDate)}
                onChange={(e) => setStartDate(e.target.value)}
              />
              <span className="export-date-separator">to</span>
              <input
                type="date"
                className="export-date-input"
                value={endDate}
                min={toInputDate(minDate)}
                max={toInputDate(maxDate)}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          {/* Export Types */}
          <div className="export-section">
            <div className="export-section-title">Export Types</div>
            <div className="export-toggle-group">
              <label className="export-toggle-row">
                <input
                  type="checkbox"
                  checked={exportTemporal}
                  onChange={(e) => setExportTemporal(e.target.checked)}
                />
                <div>
                  <div className="export-toggle-label">Temporal Graphs (CSV)</div>
                  <div className="export-toggle-desc">Basin time series per variable (ROI sum for precipitation/snowfall, mean for others)</div>
                </div>
              </label>
              <label className="export-toggle-row">
                <input
                  type="checkbox"
                  checked={exportSpatial}
                  onChange={(e) => setExportSpatial(e.target.checked)}
                />
                <div>
                  <div className="export-toggle-label">Spatial Raster Maps</div>
                  <div className="export-toggle-desc">Gridded data as GeoTIFF or CSV</div>
                </div>
              </label>
            </div>
          </div>

          {/* Spatial Options */}
          {exportSpatial && (
            <div className="export-options-card">
              <div className="export-radio-group">
                <div className="export-radio-group-label">Format</div>
                <div className="export-radio-row">
                  {['geotiff', 'csv'].map((fmt) => (
                    <label
                      key={fmt}
                      className={`export-radio-chip${spatialFormat === fmt ? ' active' : ''}`}
                    >
                      <input
                        type="radio"
                        name="spatialFormat"
                        value={fmt}
                        checked={spatialFormat === fmt}
                        onChange={() => setSpatialFormat(fmt)}
                      />
                      {fmt === 'geotiff' ? 'GeoTIFF (.tif)' : 'CSV (.csv)'}
                    </label>
                  ))}
                </div>
              </div>

              {spatialFormat === 'geotiff' && (
                <div className="export-radio-group">
                  <div className="export-radio-group-label">Temporal Aggregation</div>
                  <div className="export-radio-row">
                    {[
                      { value: 'daily', label: 'Daily', desc: '1 file per day' },
                      { value: 'monthly', label: 'Monthly', desc: '1 file per month (multi-band)' },
                      { value: 'yearly', label: 'Yearly', desc: '1 file per year (multi-band)' },
                    ].map((opt) => (
                      <label
                        key={opt.value}
                        className={`export-radio-chip${spatialAggregation === opt.value ? ' active' : ''}`}
                        title={opt.desc}
                      >
                        <input
                          type="radio"
                          name="spatialAggregation"
                          value={opt.value}
                          checked={spatialAggregation === opt.value}
                          onChange={() => setSpatialAggregation(opt.value)}
                        />
                        {opt.label}
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Destination Folder */}
          <div className="export-section">
            <div className="export-section-title">Destination Folder</div>
            <div className="export-dest-row">
              <div className="export-dest-input-wrap">
                <svg className="export-dest-folder-icon" viewBox="0 0 24 24">
                  <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                </svg>
                {dirHandle ? (
                  <div className="export-dest-chosen">
                    <span className="export-dest-name">{dirHandle.name}</span>
                    <span className="export-dest-tag">Direct Folder Access</span>
                  </div>
                ) : (
                  <input
                    type="text"
                    className="export-dest-input"
                    placeholder="Browser Downloads (or click Browse to choose folder)"
                    value={destinationPath}
                    onChange={(e) => setDestinationPath(e.target.value)}
                  />
                )}
                {(dirHandle || destinationPath) && (
                  <button
                    type="button"
                    className="export-dest-clear-btn"
                    onClick={handleClearFolder}
                    title="Reset to default downloads"
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" fill="none" strokeWidth="2.5">
                      <line x1="6" y1="6" x2="18" y2="18" />
                      <line x1="18" y1="6" x2="6" y2="18" />
                    </svg>
                  </button>
                )}
              </div>
              <button
                type="button"
                className="export-browse-btn"
                onClick={handleBrowseFolder}
                title="Browse destination folder on this computer"
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                  <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                </svg>
                Browse...
              </button>
            </div>
            <div className="export-dest-hint">
              {dirHandle ? (
                <span className="export-hint-direct">
                  ✓ Direct saving enabled: files will be written directly into &ldquo;{dirHandle.name}&rdquo;.
                </span>
              ) : destinationPath ? (
                <span>Files will be written to server directory: &ldquo;{destinationPath}&rdquo;</span>
              ) : (
                <span>
                  Option A: Click <strong>Browse...</strong> to pick a destination folder for direct saving, or download as ZIP after export.
                </span>
              )}
            </div>
          </div>

          {/* Progress / Results */}
          {(jobStatus || error || directSaveStatus.saving || directSaveStatus.done) && (
            <div className="export-progress-section">
              {error && <div className="export-error">{error}</div>}

              {jobStatus && !isFailed && (
                <>
                  <div className="export-progress-header">
                    <span className="export-progress-status">
                      {isCompleted ? '✓ Export Complete' : isRunning ? 'Exporting…' : jobStatus.status}
                    </span>
                    <span className="export-progress-pct">{jobStatus.progress_percent}%</span>
                  </div>
                  <div className="export-progress-bar">
                    <div
                      className="export-progress-fill"
                      style={{ width: `${jobStatus.progress_percent}%` }}
                    />
                  </div>
                  {jobStatus.message && (
                    <div className="export-progress-message">{jobStatus.message}</div>
                  )}
                </>
              )}

              {/* Direct folder writing progress (Option A) */}
              {directSaveStatus.saving && (
                <div className="export-direct-save-box">
                  <div className="export-direct-save-header">
                    <span className="export-direct-save-title">
                      Writing files directly to &ldquo;{dirHandle?.name}&rdquo;...
                    </span>
                    <span className="export-direct-save-count">
                      {directSaveStatus.count} / {directSaveStatus.total}
                    </span>
                  </div>
                  <div className="export-progress-bar">
                    <div
                      className="export-progress-fill export-direct-fill"
                      style={{
                        width: `${directSaveStatus.total ? (directSaveStatus.count / directSaveStatus.total) * 100 : 0}%`,
                      }}
                    />
                  </div>
                  <div className="export-direct-save-filename">
                    {directSaveStatus.currentFile}
                  </div>
                </div>
              )}

              {directSaveStatus.done && (
                <div className="export-direct-save-success">
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                    <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
                  </svg>
                  <span>
                    Successfully saved {directSaveStatus.count} files directly to &ldquo;{dirHandle?.name}&rdquo;
                  </span>
                </div>
              )}

              {directSaveStatus.error && (
                <div className="export-error">
                  {directSaveStatus.error}
                </div>
              )}

              {isFailed && (
                <div className="export-error">
                  {jobStatus.error || jobStatus.message || 'Export failed'}
                </div>
              )}

              {isCompleted && (
                <div className="export-completed-summary">
                  <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" /></svg>
                  {jobStatus.files_generated} files generated
                </div>
              )}

              <div className="export-progress-actions">
                {isRunning && (
                  <button className="export-cancel-btn" onClick={handleCancel}>Cancel</button>
                )}

                {/* Direct save to folder button if user wants to save/resave */}
                {isCompleted && !directSaveStatus.saving && (
                  <button
                    type="button"
                    className="export-btn-folder"
                    onClick={async () => {
                      if (supportsDirPicker) {
                        try {
                          const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
                          setDirHandle(handle);
                          setDestinationPath(handle.name);
                          saveFilesToDirHandle(jobId, handle);
                        } catch (err) {
                          if (err.name !== 'AbortError') console.warn(err);
                        }
                      } else {
                        alert('Folder selection is supported in Chrome and Edge.');
                      }
                    }}
                    title="Save all generated files directly into a local folder"
                  >
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                      <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
                    </svg>
                    {directSaveStatus.done ? 'Save to Another Folder' : 'Save to Folder (Browse)'}
                  </button>
                )}

                {/* Universal ZIP download fallback */}
                {isCompleted && jobStatus.download_ready && (
                  <a
                    className="export-download-btn"
                    href={apiService.getExportDownloadUrl(jobId)}
                    download
                    title="Download all files as a single ZIP archive"
                  >
                    <svg viewBox="0 0 24 24" fill="currentColor">
                      <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
                    </svg>
                    Download ZIP
                  </a>
                )}
                {(isCompleted || isFailed || jobStatus?.status === 'cancelled') && (
                  <button className="export-btn-secondary" onClick={handleReset}>New Export</button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {!jobId && (
          <div className="export-modal-footer">
            <button className="export-btn-secondary" onClick={handleClose}>Cancel</button>
            <button
              className="export-btn-primary"
              disabled={!canExport}
              onClick={handleExport}
            >
              <svg viewBox="0 0 24 24" fill="currentColor" style={{ width: 18, height: 18 }}>
                <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
              </svg>
              Start Export
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default React.memo(ExportDataModal);
