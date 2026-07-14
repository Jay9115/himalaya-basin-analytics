import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import MapView from './components/MapView';
import TimeSlider from './components/TimeSlider';
import ElevationFilter from './components/ElevationFilter';
import TempGraph from './components/TempGraph';
import DocumentationPage from './components/DocumentationPage';
import OutcomeLongTermHotspotPage from './components/OutcomeLongTermHotspotPage';
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

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function App() {
  // State management
  const [theme, setTheme] = useState(() => {
    const stored = localStorage.getItem('theme');
    return stored === 'light' || stored === 'dark' ? stored : 'dark';
  });
  const [datasets, setDatasets] = useState([]);
  const [outcomes, setOutcomes] = useState([]);
  const [selectedOutcomeId, setSelectedOutcomeId] = useState('long_term_hotspot');
  const [datasetId, setDatasetId] = useState('');
  const [homeModule, setHomeModule] = useState('dashboard');
  const [datasetReady, setDatasetReady] = useState(false);
  const [outcomeReady, setOutcomeReady] = useState(false);
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
  const [variablesContextKey, setVariablesContextKey] = useState('');
  const [years, setYears] = useState([]);
  const [selectedYear, setSelectedYear] = useState(null);
  const [regionSelectMode, setRegionSelectMode] = useState(false);
  const [regionBounds, setRegionBounds] = useState(null);
  const [regionPreview, setRegionPreview] = useState(null);
  const [subregions, setSubregions] = useState([]);
  const [subregionsLoading, setSubregionsLoading] = useState(false);
  const [selectedSubregionId, setSelectedSubregionId] = useState('');
  const [selectedSubregionFeature, setSelectedSubregionFeature] = useState(null);
  const [subregionSearchText, setSubregionSearchText] = useState('');
  const [subregionDropdownOpen, setSubregionDropdownOpen] = useState(false);
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
  const [mapViewMode, setMapViewMode] = useState('basin');
  const [analysisMode, setAnalysisMode] = useState('daily');
  const [hotspotData, setHotspotData] = useState([]);
  const [hotspotSummary, setHotspotSummary] = useState(null);
  const [hotspotLoading, setHotspotLoading] = useState(false);
  const [hotspotError, setHotspotError] = useState('');
  const [hotspotMinYears, setHotspotMinYears] = useState(3);
  const [graphData, setGraphData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(500); // ms per frame
  const [error, setError] = useState(null);
  const [stats, setStats] = useState(null);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const stored = Number(localStorage.getItem('sidebarWidth'));
    return Number.isFinite(stored) ? clamp(stored, 240, 560) : 320;
  });
  const [bottomPanelHeight, setBottomPanelHeight] = useState(() => {
    const stored = Number(localStorage.getItem('bottomPanelHeight'));
    return Number.isFinite(stored) ? clamp(stored, 180, 520) : 360;
  });
  
  const animationRef = useRef(null);
  const mapAbortRef = useRef(null);
  const hotspotAbortRef = useRef(null);
  const graphAbortRef = useRef(null);
  const subregionGeometryAbortRef = useRef(null);
  const appContentRef = useRef(null);
  const activeYearRange = selectedYearRange.start !== null && selectedYearRange.end !== null
    ? selectedYearRange
    : null;
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
    const items = normalizedSubregionQuery
      ? glacierSubregions.filter((item) => {
          const searchText = `${item.label || ''} ${item.id || ''} glacier`.toLowerCase();
          return searchText.includes(normalizedSubregionQuery);
        })
      : glacierSubregions;
    return items.slice(0, normalizedSubregionQuery ? 20 : 12);
  }, [glacierSubregions, normalizedSubregionQuery]);
  const isHotspotMode = analysisMode === 'hotspot';
  const glacierViewEnabled = mapViewMode === 'glacier';
  const displayedMapData = isHotspotMode ? hotspotData : mapData;
  const hotspotMinYearsMax = activeYearRange
    ? Math.max(2, activeYearRange.end - activeYearRange.start + 1)
    : 2;
  const mapPointCount = displayedMapData.length;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem('sidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem('bottomPanelHeight', String(bottomPanelHeight));
  }, [bottomPanelHeight]);

  const handleSidebarResizeStart = useCallback((event) => {
    event.preventDefault();
    const contentRect = appContentRef.current?.getBoundingClientRect();
    const leftOffset = contentRect?.left ?? 0;
    const maxWidth = contentRect ? Math.min(560, Math.max(280, contentRect.width * 0.45)) : 560;

    const handleMouseMove = (moveEvent) => {
      setSidebarWidth(clamp(moveEvent.clientX - leftOffset, 240, maxWidth));
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

  useEffect(() => {
    const loadHomeOptions = async () => {
      try {
        setDatasetLoading(true);
        const [datasetsResponse, outcomesResponse] = await Promise.all([
          apiService.getDatasets(),
          apiService.getOutcomes().catch(() => ({ outcomes: [] })),
        ]);
        const list = datasetsResponse.datasets || [];
        const outcomeList = outcomesResponse.outcomes || [];
        setDatasets(list);
        setOutcomes(outcomeList);
        if (outcomeList.length > 0) {
          const firstOutcome = outcomeList.find((item) => item.ready) || outcomeList[0];
          setSelectedOutcomeId(firstOutcome.id);
        }
        const preferred = list.find((d) => d.id === datasetsResponse.default_dataset && d.ready);
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

    loadHomeOptions();
  }, []);

  useEffect(() => {
    if (!regionBounds) return;
    setRegionLatMin(regionBounds.minLat.toFixed(4));
    setRegionLatMax(regionBounds.maxLat.toFixed(4));
    setRegionLonMin(regionBounds.minLon.toFixed(4));
    setRegionLonMax(regionBounds.maxLon.toFixed(4));
  }, [regionBounds]);

  useEffect(() => {
    if (isHotspotMode && isPlaying) {
      setIsPlaying(false);
    }
  }, [isHotspotMode, isPlaying]);

  useEffect(() => {
    if (!activeYearRange) return;
    const maxAllowed = Math.max(2, activeYearRange.end - activeYearRange.start + 1);
    setHotspotMinYears((prev) => Math.min(maxAllowed, Math.max(2, prev)));
  }, [activeYearRange]);

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
    if (!datasetReady || !selectedSubregionId) {
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
  }, [datasetReady, selectedSubregionId]);

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
      const contextKey = `${datasetId}:${activeYearRange.start}-${activeYearRange.end}`;
      try {
        setLoading(true);
        setError(null);
        setVariables([]);
        setSelectedVariable('');
        setVariablesContextKey('');
        setMapData([]);
        setGraphData([]);
        setHotspotData([]);
        
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
              setVariablesContextKey(contextKey);
            }
          })
          .catch(err => {
            setVariablesContextKey('');
            console.warn('Could not load variables:', err);
          });
        
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
    if (!datasetReady || !datasetId || !currentDate || !activeYearRange || !selectedVariableReady || isHotspotMode) return;

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
  }, [datasetReady, datasetId, currentDate, selectedElevRange, selectedVariable, selectedVariableReady, activeYearRange, selectedSubregionId, isHotspotMode]);

  // Fetch hotspot trends for long-term change analysis
  useEffect(() => {
    if (!datasetReady || !datasetId || !activeYearRange || !selectedVariableReady || !isHotspotMode) return;

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
          selectedSubregionId || undefined,
          hotspotMinYears
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
    isHotspotMode,
    hotspotMinYears,
  ]);

  // Fetch graph data when elevation changes
  useEffect(() => {
    if (!datasetReady || !datasetId || !dates || dates.length === 0 || !activeYearRange || !selectedVariableReady) return;

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
  }, [datasetReady, datasetId, dates, selectedElevRange, selectedVariable, selectedVariableReady, regionBounds, selectedYear, activeYearRange, selectedSubregionId]);

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

  const handleAnalysisModeChange = useCallback((mode) => {
    setAnalysisMode(mode === 'hotspot' ? 'hotspot' : 'daily');
    setHotspotError('');
    if (mode === 'hotspot') {
      setIsPlaying(false);
    }
  }, []);

  const handleHotspotMinYearsChange = useCallback((value) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed)) return;
    const clamped = Math.min(hotspotMinYearsMax, Math.max(2, parsed));
    setHotspotMinYears(clamped);
  }, [hotspotMinYearsMax]);

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
    setSelectedSubregionFeature(null);
    setRegionInputError('');
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
    mapAbortRef.current?.abort?.();
    hotspotAbortRef.current?.abort?.();
    graphAbortRef.current?.abort?.();
    subregionGeometryAbortRef.current?.abort?.();
    setRegionBounds(null);
    setRegionPreview(null);
    setSelectedSubregionId('');
    setSelectedSubregionFeature(null);
    setGraphData([]);
    setMapData([]);
    setHotspotData([]);
    setHotspotSummary(null);
    setHotspotLoading(false);
    setHotspotError('');
    setHotspotMinYears(3);
    setAnalysisMode('daily');
    setMapViewMode('basin');
    setError(null);
    setShowDocumentation(false);
    setOutcomeReady(false);
    setDatasetReady(true);
  }, [datasetId, activeYearRange]);

  const handleStartOutcome = useCallback(() => {
    const selectedOutcome = outcomes.find((item) => item.id === selectedOutcomeId);
    if (!selectedOutcome || !selectedOutcome.ready) {
      setError('Selected outcome is not ready. Generate outcome outputs first.');
      return;
    }

    apiService.clearCache();
    mapAbortRef.current?.abort?.();
    hotspotAbortRef.current?.abort?.();
    graphAbortRef.current?.abort?.();
    subregionGeometryAbortRef.current?.abort?.();
    setIsPlaying(false);
    setShowDocumentation(false);
    setError(null);
    setLoading(false);
    setMapViewMode('basin');
    setDatasetReady(false);
    setOutcomeReady(true);
  }, [outcomes, selectedOutcomeId]);

  const handleGoHome = useCallback(() => {
    setIsPlaying(false);
    mapAbortRef.current?.abort?.();
    hotspotAbortRef.current?.abort?.();
    graphAbortRef.current?.abort?.();
    subregionGeometryAbortRef.current?.abort?.();
    setRegionSelectMode(false);
    setRegionPreview(null);
    setRegionBounds(null);
    setSelectedSubregionId('');
    setSelectedSubregionFeature(null);
    setFocusLocation(null);
    setHotspotData([]);
    setHotspotSummary(null);
    setHotspotLoading(false);
    setHotspotError('');
    setHotspotMinYears(3);
    setAnalysisMode('daily');
    setMapViewMode('basin');
    setOutcomeReady(false);
    setError(null);
    setShowDocumentation(false);
    setDatasetReady(false);
  }, []);

  const handleToggleDocumentation = useCallback(() => {
    setShowDocumentation((prev) => !prev);
  }, []);

  const handleHomeModuleChange = useCallback((moduleName) => {
    const nextModule = moduleName === 'outcomes' ? 'outcomes' : 'dashboard';
    setHomeModule(nextModule);
    setError(null);
    if (nextModule === 'outcomes') {
      setShowDocumentation(false);
    }
  }, []);

  const regionAction = regionSelectMode ? 'cancel' : regionBounds ? 'clear' : 'select';
  const regionActionLabel = regionSelectMode ? 'Cancel Selection' : regionBounds ? 'Clear Selection' : 'Select Region';

  const selectedDataset = datasets.find((d) => d.id === datasetId);
  const selectedOutcome = outcomes.find((item) => item.id === selectedOutcomeId) || null;
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

  if (!datasetReady && !outcomeReady) {
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
          <h2>Start Here</h2>
          <p>Select the workflow, then narrow the dataset and year window before loading.</p>
          {error && <div className="dataset-error">{error}</div>}
          <div className="home-module-options">
            <label className={`home-module-option ${homeModule === 'dashboard' ? 'active' : ''}`}>
              <input
                type="radio"
                name="home-module"
                value="dashboard"
                checked={homeModule === 'dashboard'}
                onChange={() => handleHomeModuleChange('dashboard')}
              />
              <div className="home-module-text">
                <div className="home-module-title">Interactive Dashboard</div>
                <div className="home-module-meta">Live analysis: map, time slider, region tools, and graphs.</div>
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
                <div className="home-module-title">Outcomes</div>
                <div className="home-module-meta">Precomputed outputs ready for quick comparison and review.</div>
              </div>
            </label>
          </div>
          {homeModule === 'dashboard' && (
            <>
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
                        Source files: parquet {dataset.parquet_files} | geotiff {dataset.geotiff_files || 0} | csv {dataset.csv_files}
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
              <div className="year-range-panel">
                <h3>Year Range</h3>
                <p>Choose a smaller time window first to keep indexing and loading fast.</p>
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
                Open Dashboard
              </button>
            </>
          )}
          {homeModule === 'outcomes' && (
            <>
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
              <button
                className="dataset-start-btn"
                type="button"
                onClick={handleStartOutcome}
                disabled={!selectedOutcome || !selectedOutcome.ready}
              >
                Open Outcome View
              </button>
            </>
          )}
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
  if (!outcomeReady && loading) {
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

  if (outcomeReady) {
    return (
      <div className="app" data-theme={theme}>
        <header className="app-header">
          <h1>Himalayan Basin Visualization</h1>
          <div className="header-controls">
            <button
              className="home-btn"
              onClick={handleGoHome}
              type="button"
              title="Back to module selection"
            >
              Home
            </button>
            <div className="dataset-badge">
              Outcome: Long Term Hotspot Analysis
            </div>
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
        <div className="app-content">
          <OutcomeLongTermHotspotPage theme={theme} />
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
      <div
        ref={appContentRef}
        className={`app-content ${showDocumentation ? 'docs-only-content' : ''}`}
      >
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
        <aside
          className="sidebar"
          style={{ width: `${sidebarWidth}px`, flexBasis: `${sidebarWidth}px` }}
        >
          <div className="search-panel">
            <h3>Jump to Coordinates</h3>
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
            <div className="map-mode-picker">
              <label>Map View</label>
              <div className="map-mode-switch">
                <button
                  type="button"
                  className={`map-mode-btn ${!glacierViewEnabled ? 'active' : ''}`}
                  onClick={() => setMapViewMode('basin')}
                >
                  Basin View
                </button>
                <button
                  type="button"
                  className={`map-mode-btn ${glacierViewEnabled ? 'active' : ''}`}
                  onClick={() => setMapViewMode('glacier')}
                >
                  Glacier View
                </button>
              </div>
            </div>
            <div className="subregion-picker">
              <label htmlFor="subregion-select">Sub-Region</label>
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
                    <button
                      type="button"
                      className={`subregion-option ${selectedSubregionId === '' ? 'selected' : ''}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => handleSubregionChange('')}
                    >
                      <span className="subregion-option-label">Custom Rectangle (draw/manual)</span>
                      <span className="subregion-option-meta">No preset selection</span>
                    </button>

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
            </div>
            <div className="region-panel-note">Draw a rectangle, enter coordinates, or choose a sub-region.</div>
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
                    Sub-Region: {selectedSubregion.label}
                    {selectedSubregion.kind === 'glacier' ? '' : ` (ID: ${selectedSubregion.id})`}
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
            <h3>Variable Selection</h3>
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

          <div className="hotspot-panel">
            <h3>Long-Term Hotspots</h3>
            <p>Identify where the selected variable changed the fastest across the chosen years.</p>
            <div className="hotspot-mode-switch">
              <button
                type="button"
                className={`hotspot-mode-btn ${!isHotspotMode ? 'active' : ''}`}
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
            {!isHotspotMode && (
              <div className="hotspot-hint">
                Daily map mode shows date-wise values. Switch to hotspot mode for long-term trend intensity.
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
            <h3>Live Summary</h3>
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
                <span className="value">
                  {selectedSubregion.label}
                  {selectedSubregion.kind === 'glacier' ? '' : ` (ID: ${selectedSubregion.id})`}
                </span>
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
              <span className="label">{isHotspotMode ? 'Trend Points:' : 'Data Points:'}</span>
              <span className="value">{mapPointCount.toLocaleString()}</span>
            </div>
          </div>
        </aside>
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize sidebar"
          onMouseDown={handleSidebarResizeStart}
        />

        {/* Main visualization area */}
        <main className="main-content">
          {/* Map */}
          <div className="map-container">
            <MapView
              data={displayedMapData}
              currentDate={currentDate}
              theme={theme}
              variableLabel={variableLabel}
              selectionEnabled={regionSelectMode}
              onSelectionComplete={handleRegionSelect}
              onSelectionPreview={handleRegionPreview}
              selectionBounds={regionBounds}
              selectedSubregionFeature={selectedSubregionFeature}
              glacierViewEnabled={glacierViewEnabled}
              focusLocation={focusLocation}
              analysisMode={analysisMode}
              hotspotSummary={hotspotSummary}
            />
          </div>

          <div
            className="bottom-analysis-panel"
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
            {/* Controls */}
            <div className="controls-container">
              {isHotspotMode && (
                <div className="hotspot-time-note">
                  Hotspot mode uses the full selected year range for trend fitting. The time slider only moves the graph marker.
                </div>
              )}
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
          </div>
        </main>
          </>
        )}
      </div>
    </div>
  );
}

export default App;

