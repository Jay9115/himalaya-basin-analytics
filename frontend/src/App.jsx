import React, { useState, useEffect, useCallback, useRef } from 'react';
import MapView from './components/MapView';
import TimeSlider from './components/TimeSlider';
import ElevationFilter from './components/ElevationFilter';
import TempGraph from './components/TempGraph';
import DocumentationPage from './components/DocumentationPage';
import apiService from './services/api';
import './App.css';

const formatVariableLabel = (name) => {
  if (!name) return '';
  const parts = name.split('_');
  if (parts.length === 1) {
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  const unit = parts[parts.length - 1];
  const label = parts.slice(0, -1).join(' ');
  const prettyLabel = label.replace(/\b\w/g, (c) => c.toUpperCase());
  return `${prettyLabel} (${unit})`;
};

function App() {
  // State management
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem('theme');
    return stored === 'light' || stored === 'dark' ? stored : 'dark';
  });
  const [datasets, setDatasets] = useState([]);
  const [datasetId, setDatasetId] = useState('');
  const [datasetReady, setDatasetReady] = useState(false);
  const [datasetLoading, setDatasetLoading] = useState(true);
  const [showDocumentation, setShowDocumentation] = useState(false);
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
  const [selectedVariable, setSelectedVariable] = useState('temperature_C');
  const [years, setYears] = useState([]);
  const [selectedYear, setSelectedYear] = useState(null);
  const [regionSelectMode, setRegionSelectMode] = useState(false);
  const [regionBounds, setRegionBounds] = useState(null);
  const [regionPreview, setRegionPreview] = useState(null);
  const [subregions, setSubregions] = useState([]);
  const [subregionsLoading, setSubregionsLoading] = useState(false);
  const [selectedSubregionId, setSelectedSubregionId] = useState('');
  const [regionLatMin, setRegionLatMin] = useState('');
  const [regionLatMax, setRegionLatMax] = useState('');
  const [regionLonMin, setRegionLonMin] = useState('');
  const [regionLonMax, setRegionLonMax] = useState('');
  const [regionInputError, setRegionInputError] = useState('');
  const [searchLat, setSearchLat] = useState('');
  const [searchLon, setSearchLon] = useState('');
  const [searchError, setSearchError] = useState('');
  const [focusLocation, setFocusLocation] = useState(null);
  const [elevationRange, setElevationRange] = useState({ min: 500, max: 9000 });
  const [selectedElevRange, setSelectedElevRange] = useState({ min: 500, max: 9000 });
  const [mapData, setMapData] = useState([]);
  const [graphData, setGraphData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(500); // ms per frame
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  
  const animationRef = useRef(null);
  const mapAbortRef = useRef(null);
  const graphAbortRef = useRef(null);
  const activeYearRange = selectedYearRange.start !== null && selectedYearRange.end !== null
    ? selectedYearRange
    : null;
  const selectedSubregion = subregions.find((item) => item.id === selectedSubregionId) || null;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    const loadDatasets = async () => {
      try {
        setDatasetLoading(true);
        const response = await apiService.getDatasets();
        const list = response.datasets || [];
        setDatasets(list);
        const preferred = list.find((d) => d.id === response.default_dataset && d.ready);
        const firstReady = list.find((d) => d.ready);
        const firstAny = list[0];
        setDatasetId((preferred || firstReady || firstAny)?.id || '');
      } catch (err) {
        console.error('Failed to load datasets:', err);
        setError('Failed to load dataset list from backend.');
      } finally {
        setDatasetLoading(false);
      }
    };

    loadDatasets();
  }, []);

  useEffect(() => {
    if (!regionBounds) return;
    setRegionLatMin(regionBounds.minLat.toFixed(4));
    setRegionLatMax(regionBounds.maxLat.toFixed(4));
    setRegionLonMin(regionBounds.minLon.toFixed(4));
    setRegionLonMax(regionBounds.maxLon.toFixed(4));
  }, [regionBounds]);

  useEffect(() => {
    if (!datasetReady) return;

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
  }, [datasetReady]);

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
          return;
        }

        const minYear = Number.isInteger(response.min_year) ? response.min_year : years[0];
        const maxYear = Number.isInteger(response.max_year) ? response.max_year : years[years.length - 1];
        const defaultEndYear = Math.min(minYear + 1, maxYear);

        setSelectedYearRange((prev) => {
          const hasExistingSelection = Number.isInteger(prev.start) && Number.isInteger(prev.end);
          const currentStart = hasExistingSelection ? prev.start : minYear;
          const currentEnd = hasExistingSelection ? prev.end : defaultEndYear;
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
    if (!datasetReady || !datasetId || !activeYearRange) return;

    const initialize = async () => {
      try {
        setLoading(true);
        setError(null);
        
        // Fetch available dates (critical)
        const datesResponse = await apiService.getAvailableDates(datasetId, activeYearRange);
        if (datesResponse.dates && datesResponse.dates.length > 0) {
          setDates(datesResponse.dates);
          setCurrentDate(datesResponse.dates[0]);
          setCurrentDateIndex(0);
          setLoading(false); // Allow UI to show while other data loads
          const yearSet = Array.from(new Set(datesResponse.dates.map((d) => d.slice(0, 4)))).sort();
          setYears(yearSet);
          setSelectedYear(yearSet[0] || null);
        } else {
          setError(
            `No data available for dataset '${datasetId}' in ${activeYearRange.start}-${activeYearRange.end}.`
          );
          setLoading(false);
          return;
        }
        
        // Fixed elevation band for all datasets.
        setElevationRange({ min: 500, max: 9000 });
        setSelectedElevRange({ min: 500, max: 9000 });
        
        // Fetch stats (optional - non-blocking)
        apiService.getStats(datasetId, activeYearRange)
          .then(statsResponse => setStats(statsResponse))
          .catch(err => console.warn('Could not load stats:', err));

        // Fetch available variables (non-blocking)
        apiService.getAvailableVariables(datasetId, activeYearRange)
          .then(varResponse => {
            if (varResponse.variables && varResponse.variables.length > 0) {
              setVariables(varResponse.variables);
              setSelectedVariable(varResponse.default_variable || varResponse.variables[0]);
            }
          })
          .catch(err => console.warn('Could not load variables:', err));
        
      } catch (err) {
        console.error('Initialization error:', err);
        setError('Failed to connect to backend. Please ensure the FastAPI server is running on port 8000.');
        setLoading(false);
      }
    };

    initialize();
  }, [datasetReady, datasetId, activeYearRange]);

  // Fetch map data when date or elevation changes
  useEffect(() => {
    if (!datasetReady || !datasetId || !currentDate || !activeYearRange) return;

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
          selectedSubregionId || undefined
        );
        
        setMapData(response.data || []);
        
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
  }, [datasetReady, datasetId, currentDate, selectedElevRange, selectedVariable, activeYearRange, selectedSubregionId]);

  // Fetch graph data when elevation changes
  useEffect(() => {
    if (!datasetReady || !datasetId || !dates || dates.length === 0 || !activeYearRange) return;

    const controller = new AbortController();
    if (graphAbortRef.current) {
      graphAbortRef.current.abort();
    }
    graphAbortRef.current = controller;

    const fetchGraphData = async () => {
      try {
        if (regionBounds && selectedYear) {
          const response = await apiService.getRegionMean(
            selectedYear,
            regionBounds,
            selectedElevRange.min,
            selectedElevRange.max,
            selectedVariable,
            datasetId,
            controller.signal,
            activeYearRange,
            selectedSubregionId || undefined
          );
          setGraphData(response.data || []);
        } else {
          const startDate = dates[0];
          const endDate = dates[dates.length - 1];
          
          const response = await apiService.getBasinMean(
            startDate,
            endDate,
            selectedElevRange.min,
            selectedElevRange.max,
            selectedVariable,
            datasetId,
            controller.signal,
            activeYearRange,
            selectedSubregionId || undefined
          );
          
          setGraphData(response.data || []);
        }
      } catch (err) {
        const isCanceled = err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED';
        if (isCanceled) return;
        console.error('Error fetching graph data:', err);
        // Don't block the app if graph fails
        setGraphData([]);
      }
    };

    // Delay graph load to prioritize map
    const timer = setTimeout(fetchGraphData, regionBounds ? 200 : 1000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [datasetReady, datasetId, dates, selectedElevRange, selectedVariable, regionBounds, selectedYear, activeYearRange, selectedSubregionId]);

  // Animation control using requestAnimationFrame
  const animate = useCallback(() => {
    if (!isPlaying) return;

    setCurrentDateIndex((prevIndex) => {
      const nextIndex = prevIndex + 1;
      
      if (nextIndex >= dates.length) {
        setIsPlaying(false);
        return 0; // Reset to start
      }
      
      setCurrentDate(dates[nextIndex]);
      return nextIndex;
    });

    animationRef.current = setTimeout(() => {
      requestAnimationFrame(animate);
    }, playSpeed);
  }, [isPlaying, dates, playSpeed]);

  useEffect(() => {
    if (isPlaying) {
      animationRef.current = setTimeout(() => {
        requestAnimationFrame(animate);
      }, playSpeed);
    } else {
      if (animationRef.current) {
        clearTimeout(animationRef.current);
      }
    }

    return () => {
      if (animationRef.current) {
        clearTimeout(animationRef.current);
      }
    };
  }, [isPlaying, animate, playSpeed]);

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

  const variableLabel = formatVariableLabel(selectedVariable);
  const handleToggleRegion = useCallback(() => {
    if (regionSelectMode) {
      setRegionSelectMode(false);
      setRegionBounds(null);
      setRegionPreview(null);
      return;
    }
    if (regionBounds) {
      setRegionBounds(null);
      setRegionPreview(null);
      return;
    }
    setRegionSelectMode(true);
  }, [regionSelectMode, regionBounds]);

  const handleRegionSelect = useCallback((bounds) => {
    setRegionBounds(bounds);
    setRegionSelectMode(false);
    setRegionPreview(null);
    setRegionInputError('');
    if (currentDate) {
      setSelectedYear(currentDate.slice(0, 4));
    }
  }, [currentDate]);

  const handleRegionPreview = useCallback((bounds) => {
    setRegionPreview(bounds);
  }, []);

  const handleRegionApply = useCallback(() => {
    const minLat = parseFloat(regionLatMin);
    const maxLat = parseFloat(regionLatMax);
    const minLon = parseFloat(regionLonMin);
    const maxLon = parseFloat(regionLonMax);

    if (![minLat, maxLat, minLon, maxLon].every((v) => Number.isFinite(v))) {
      setRegionInputError('Enter valid latitude and longitude values.');
      return;
    }
    if (minLat < -90 || maxLat > 90 || minLon < -180 || maxLon > 180) {
      setRegionInputError('Lat must be -90 to 90 and Lon -180 to 180.');
      return;
    }
    const bounds = {
      minLat: Math.min(minLat, maxLat),
      maxLat: Math.max(minLat, maxLat),
      minLon: Math.min(minLon, maxLon),
      maxLon: Math.max(minLon, maxLon),
    };
    setRegionInputError('');
    setRegionBounds(bounds);
    setRegionSelectMode(false);
    setRegionPreview(null);
    if (currentDate) {
      setSelectedYear(currentDate.slice(0, 4));
    }
  }, [regionLatMin, regionLatMax, regionLonMin, regionLonMax, currentDate]);

  const handleSubregionChange = useCallback((value) => {
    setSelectedSubregionId(value);
    setRegionInputError('');
  }, []);

  const handleSearch = useCallback(() => {
    const lat = parseFloat(searchLat);
    const lon = parseFloat(searchLon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setSearchError('Enter valid latitude and longitude.');
      return;
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      setSearchError('Latitude must be -90 to 90 and longitude -180 to 180.');
      return;
    }
    setSearchError('');
    setFocusLocation({ lat, lon });
  }, [searchLat, searchLon]);

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
    setRegionBounds(null);
    setRegionPreview(null);
    setSelectedSubregionId('');
    setGraphData([]);
    setMapData([]);
    setError(null);
    setShowDocumentation(false);
    setDatasetReady(true);
  }, [datasetId, activeYearRange]);

  const handleGoHome = useCallback(() => {
    setIsPlaying(false);
    setRegionSelectMode(false);
    setRegionPreview(null);
    setRegionBounds(null);
    setSelectedSubregionId('');
    setFocusLocation(null);
    setError(null);
    setShowDocumentation(false);
    setDatasetReady(false);
  }, []);

  const handleToggleDocumentation = useCallback(() => {
    setShowDocumentation((prev) => !prev);
  }, []);

  const regionAction = regionSelectMode ? 'cancel' : regionBounds ? 'clear' : 'select';
  const regionActionLabel = regionSelectMode ? 'Cancel Selection' : regionBounds ? 'Clear Selection' : 'Select Region';

  const selectedDataset = datasets.find((d) => d.id === datasetId);
  const yearMin = yearOptions.length > 0 ? yearOptions[0] : null;
  const yearMax = yearOptions.length > 0 ? yearOptions[yearOptions.length - 1] : null;

  if (datasetLoading) {
    return (
      <div className="loading-screen">
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
              <button
                className="home-btn"
                onClick={handleToggleDocumentation}
                type="button"
                title="Back to dataset selection"
              >
                Back
              </button>
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
            <DocumentationPage
              selectedDataset={selectedDataset}
              selectedYearRange={activeYearRange}
              selectedVariable={selectedVariable}
              stats={stats}
            />
          </div>
        </div>
      );
    }

    return (
      <div className="dataset-screen">
        <div className="dataset-card">
          <h2>Select Dataset</h2>
          <p>Choose which dataset to load before opening maps and plots.</p>
          {error && <div className="dataset-error">{error}</div>}
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
                    id: {dataset.id} | parquet: {dataset.parquet_files} | csv: {dataset.csv_files}
                  </div>
                </div>
              </label>
            ))}
          </div>
          <div className="nc-upload-panel">
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
            <p>Convert uploaded satellite NetCDF to parquet and add it as a new dataset.</p>
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
          <div className="year-range-panel">
            <h3>Year Range</h3>
            <p>Only this year window will be indexed and loaded.</p>
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
            Start With Selected Dataset
          </button>
          <button
            className="dataset-docs-btn"
            type="button"
            onClick={handleToggleDocumentation}
          >
            Open Scientific Documentation
          </button>
        </div>
      </div>
    );
  }

  // Loading screen
  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner"></div>
        <p>Loading temperature data...</p>
      </div>
    );
  }

  // Error screen
  if (error) {
    return (
      <div className="error-screen">
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
      <header className="app-header">
        <h1>Himalayan Basin Visualization</h1>
        <div className="header-controls">
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
            {showDocumentation ? 'Back To Analysis' : 'Documentation'}
          </button>
          {selectedDataset && (
            <div className="dataset-badge">
              Dataset: {selectedDataset.label}
              {activeYearRange && ` | Years: ${activeYearRange.start}-${activeYearRange.end}`}
            </div>
          )}
          {stats && (
            <div className="stats-badge">
              {stats.total_dates} days | {stats.total_files} files | {stats.total_size_mb} MB
            </div>
          )}
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

      {/* Main content */}
      <div className={`app-content ${showDocumentation ? 'docs-only-content' : ''}`}>
        {showDocumentation ? (
          <DocumentationPage
            selectedDataset={selectedDataset}
            selectedYearRange={activeYearRange}
            selectedVariable={selectedVariable}
            stats={stats}
          />
        ) : (
          <>
        {/* Left sidebar */}
        <aside className="sidebar">
          <div className="search-panel">
            <h3>Go To Coordinate</h3>
            <div className="search-row">
              <label htmlFor="search-lat">Latitude</label>
              <input
                id="search-lat"
                type="number"
                step="0.0001"
                value={searchLat}
                onChange={(e) => setSearchLat(e.target.value)}
                placeholder="e.g. 34.12"
              />
            </div>
            <div className="search-row">
              <label htmlFor="search-lon">Longitude</label>
              <input
                id="search-lon"
                type="number"
                step="0.0001"
                value={searchLon}
                onChange={(e) => setSearchLon(e.target.value)}
                placeholder="e.g. 75.12"
              />
            </div>
            {searchError && <div className="search-error">{searchError}</div>}
            <button className="search-btn" type="button" onClick={handleSearch}>
              Go
            </button>
          </div>

          <div className="region-panel">
            <h3>Region Selection</h3>
            <div className="subregion-picker">
              <label htmlFor="subregion-select">Sub-Region</label>
              <select
                id="subregion-select"
                value={selectedSubregionId}
                onChange={(e) => handleSubregionChange(e.target.value)}
                disabled={subregionsLoading}
              >
                <option value="">Custom Rectangle (draw/manual)</option>
                {subregions.map((region) => (
                  <option key={region.id} value={region.id}>
                    {region.label} (ID: {region.id})
                  </option>
                ))}
              </select>
              {subregionsLoading && (
                <div className="subregion-loading">Loading sub-regions...</div>
              )}
            </div>
            <button
              className={`region-btn mode-${regionAction} ${regionSelectMode ? 'active' : ''}`}
              onClick={handleToggleRegion}
              type="button"
            >
              <span className="region-square" />
              <span key={regionActionLabel} className="region-btn-label">{regionActionLabel}</span>
            </button>
            <div className="region-manual">
              <div className="region-manual-row">
                <label htmlFor="region-lat-min">Lat Min</label>
                <input
                  id="region-lat-min"
                  type="number"
                  step="0.0001"
                  value={regionLatMin}
                  onChange={(e) => setRegionLatMin(e.target.value)}
                  placeholder="e.g. 33.5"
                />
              </div>
              <div className="region-manual-row">
                <label htmlFor="region-lat-max">Lat Max</label>
                <input
                  id="region-lat-max"
                  type="number"
                  step="0.0001"
                  value={regionLatMax}
                  onChange={(e) => setRegionLatMax(e.target.value)}
                  placeholder="e.g. 36.2"
                />
              </div>
              <div className="region-manual-row">
                <label htmlFor="region-lon-min">Lon Min</label>
                <input
                  id="region-lon-min"
                  type="number"
                  step="0.0001"
                  value={regionLonMin}
                  onChange={(e) => setRegionLonMin(e.target.value)}
                  placeholder="e.g. 73.9"
                />
              </div>
              <div className="region-manual-row">
                <label htmlFor="region-lon-max">Lon Max</label>
                <input
                  id="region-lon-max"
                  type="number"
                  step="0.0001"
                  value={regionLonMax}
                  onChange={(e) => setRegionLonMax(e.target.value)}
                  placeholder="e.g. 76.4"
                />
              </div>
              {regionInputError && <div className="region-error">{regionInputError}</div>}
              <button className="region-apply" type="button" onClick={handleRegionApply}>
                Apply Coordinates
              </button>
            </div>
            {(regionBounds || regionPreview) && (
              <div className="region-details">
                <div className="region-row">
                  Lat: {(regionPreview || regionBounds).minLat.toFixed(3)} to {(regionPreview || regionBounds).maxLat.toFixed(3)}
                </div>
                <div className="region-row">
                  Lon: {(regionPreview || regionBounds).minLon.toFixed(3)} to {(regionPreview || regionBounds).maxLon.toFixed(3)}
                </div>
                {selectedSubregion && (
                  <div className="region-row">
                    Sub-Region: {selectedSubregion.label} (ID: {selectedSubregion.id})
                  </div>
                )}
                {regionBounds && years.length > 0 && (
                  <div className="region-year">
                    <label htmlFor="region-year-select">Year:</label>
                    <select
                      id="region-year-select"
                      value={selectedYear || ''}
                      onChange={(e) => setSelectedYear(e.target.value)}
                    >
                      {years.map((year) => (
                        <option key={year} value={year}>{year}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}
            {!regionBounds && (
              <div className="region-hint">Draw a rectangle or pick a sub-region for faster local analysis.</div>
            )}
          </div>

          <div className="variable-panel">
            <h3>Variable</h3>
            {variables.length === 0 && (
              <div className="variable-empty">No variables available</div>
            )}
            {variables.length > 0 && (
              <div className="variable-options">
                {variables.map((variable) => (
                  <label className="variable-option" key={variable}>
                    <input
                      type="checkbox"
                      checked={selectedVariable === variable}
                      onChange={() => setSelectedVariable(variable)}
                    />
                    <span>{formatVariableLabel(variable)}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <ElevationFilter
            min={elevationRange.min}
            max={elevationRange.max}
            selectedMin={selectedElevRange.min}
            selectedMax={selectedElevRange.max}
            onChange={handleElevationChange}
          />
          
          <div className="info-panel">
            <h3>Current Selection</h3>
            <div className="info-item">
              <span className="label">Date:</span>
              <span className="value">{currentDate}</span>
            </div>
            <div className="info-item">
              <span className="label">Variable:</span>
              <span className="value">{variableLabel}</span>
            </div>
            {selectedSubregion && (
              <div className="info-item">
                <span className="label">Sub-Region:</span>
                <span className="value">{selectedSubregion.id}</span>
              </div>
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
              <span className="label">Data Points:</span>
              <span className="value">{mapData.length.toLocaleString()}</span>
            </div>
          </div>
        </aside>

        {/* Main visualization area */}
        <main className="main-content">
          {/* Map */}
          <div className="map-container">
            <MapView
              data={mapData}
              currentDate={currentDate}
              theme={theme}
              variableLabel={variableLabel}
              selectionEnabled={regionSelectMode}
              onSelectionComplete={handleRegionSelect}
              onSelectionPreview={handleRegionPreview}
              selectionBounds={regionBounds}
              focusLocation={focusLocation}
            />
          </div>

          {/* Controls */}
          <div className="controls-container">
            <TimeSlider
              dates={dates}
              currentIndex={currentDateIndex}
              isPlaying={isPlaying}
              playSpeed={playSpeed}
              onDateChange={handleDateChange}
              onPlayPause={handlePlayPause}
              onSpeedChange={handleSpeedChange}
            />
          </div>

          {/* Graph */}
          <div className="graph-container">
            <TempGraph
              data={graphData}
              currentDate={currentDate}
              variableLabel={variableLabel}
              showPointStats={Boolean(regionBounds)}
              pointStatsLabel="Region points/day"
            />
          </div>
        </main>
          </>
        )}
      </div>
    </div>
  );
}

export default App;
