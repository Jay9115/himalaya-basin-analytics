import React, { useEffect, useMemo, useRef, useState } from 'react';
import MapView from './MapView';
import apiService from '../services/api';

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

function OutcomeLongTermHotspotPage({ theme, outcome }) {
  const outcomeId = outcome?.id || 'long_term_hotspot';
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState('');
  const [meta, setMeta] = useState(null);

  const [selectedVariable, setSelectedVariable] = useState('');
  const [selectedBandId, setSelectedBandId] = useState('');
  const [viewMode, setViewMode] = useState('mean');
  const [selectedComparisonId, setSelectedComparisonId] = useState('');
  const [mapData, setMapData] = useState([]);
  const [stats, setStats] = useState(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState('');

  const fetchAbortRef = useRef(null);

  useEffect(() => {
    let isMounted = true;
    const loadMeta = async () => {
      try {
        setMetaLoading(true);
        setMetaError('');
        const response = await apiService.getOutcomeMeta(outcomeId);
        if (!isMounted) return;
        setMeta(response);
        const defaultVariable = (response.variables || [])[0] || '';
        const defaultBandId = (response.bands || [])[0]?.id || '';
        const defaultComparisonId = (response.comparisons || [])[0]?.id || '';
        setSelectedVariable(defaultVariable);
        setSelectedBandId(String(defaultBandId));
        setSelectedComparisonId(String(defaultComparisonId));
      } catch (err) {
        if (!isMounted) return;
        const detail = err?.response?.data?.detail;
        setMetaError(detail || 'Failed to load outcome metadata.');
      } finally {
        if (isMounted) {
          setMetaLoading(false);
        }
      }
    };
    loadMeta();
    return () => {
      isMounted = false;
    };
  }, [outcomeId]);

  useEffect(() => {
    if (!selectedVariable) return;
    if (viewMode === 'mean' && !selectedBandId) return;
    if (viewMode === 'difference' && !selectedComparisonId) return;

    const controller = new AbortController();
    if (fetchAbortRef.current) {
      fetchAbortRef.current.abort();
    }
    fetchAbortRef.current = controller;

    const loadData = async () => {
      try {
        setDataLoading(true);
        setDataError('');
        const response = viewMode === 'difference'
          ? await apiService.getOutcomeDifference(
              outcomeId,
              selectedVariable,
              selectedComparisonId,
              controller.signal
            )
          : await apiService.getOutcomeData(
              outcomeId,
              selectedVariable,
              selectedBandId,
              controller.signal
            );
        setMapData(response.data || []);
        setStats(response.stats || null);
      } catch (err) {
        const isCanceled = err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED';
        if (isCanceled) return;
        const detail = err?.response?.data?.detail;
        setMapData([]);
        setStats(null);
        setDataError(detail || 'Failed to load precomputed outcome map.');
      } finally {
        if (!controller.signal.aborted) {
          setDataLoading(false);
        }
      }
    };

    loadData();
    return () => {
      controller.abort();
    };
  }, [outcomeId, selectedVariable, selectedBandId, selectedComparisonId, viewMode]);

  const selectedBand = useMemo(() => {
    if (!meta?.bands) return null;
    return meta.bands.find((band) => String(band.id) === String(selectedBandId)) || null;
  }, [meta, selectedBandId]);

  const selectedComparison = useMemo(() => {
    if (!meta?.comparisons) return null;
    return meta.comparisons.find((comparison) => String(comparison.id) === String(selectedComparisonId)) || null;
  }, [meta, selectedComparisonId]);

  const availableBandIds = useMemo(() => {
    const coverageList = meta?.coverage_by_variable?.[selectedVariable];
    if (!coverageList) {
      return new Set((meta?.bands || []).map((band) => String(band.id)));
    }
    return new Set(
      coverageList
        .filter((coverage) => (coverage.available_years || []).length > 0)
        .map((coverage) => String(coverage.band_id))
    );
  }, [meta, selectedVariable]);

  useEffect(() => {
    if (!meta || !selectedVariable || availableBandIds.size === 0) return;
    if (!availableBandIds.has(String(selectedBandId))) {
      const firstAvailableBand = (meta.bands || []).find((band) => availableBandIds.has(String(band.id)));
      setSelectedBandId(String(firstAvailableBand?.id || ''));
    }
    const validComparisons = (meta.comparisons || []).filter(
      (comparison) => availableBandIds.has(String(comparison.earlier_band_id))
        && availableBandIds.has(String(comparison.later_band_id))
    );
    if (!validComparisons.some((comparison) => String(comparison.id) === String(selectedComparisonId))) {
      setSelectedComparisonId(String(validComparisons[0]?.id || ''));
    }
  }, [availableBandIds, meta, selectedBandId, selectedComparisonId, selectedVariable]);

  const selectedCoverage = useMemo(() => {
    const coverageList = meta?.coverage_by_variable?.[selectedVariable] || meta?.coverage_by_band;
    if (!coverageList) return null;
    return coverageList.find(
      (coverage) => String(coverage.band_id) === String(selectedBandId)
    ) || null;
  }, [meta, selectedBandId, selectedVariable]);

  if (metaLoading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner"></div>
        <p>Loading outcome metadata...</p>
      </div>
    );
  }

  if (metaError) {
    return (
      <div className="error-screen">
        <div className="error-icon">!</div>
        <h2>Outcome Unavailable</h2>
        <p>{metaError}</p>
        <div className="error-instructions">
          <h3>How to generate outcome outputs</h3>
          <ol>
            <li>Open terminal in <code>Outcomes/Long_term_hotspot/Scripts</code></li>
            <li>Run <code>python compute_era5_band_means.py</code></li>
            <li>Restart backend and reopen this outcome.</li>
          </ol>
        </div>
      </div>
    );
  }

  const bandLabel = selectedBand?.label || '';
  const comparisonLabel = selectedComparison?.label || '';
  const isDifferenceMode = viewMode === 'difference';
  const selectedAggregation = meta?.aggregation_by_variable?.[selectedVariable] || 'mean';
  const aggregationLabel = selectedAggregation === 'sum' ? 'Sum' : 'Mean';
  const mapTitle = isDifferenceMode
    ? (comparisonLabel ? `Change: ${comparisonLabel}` : 'Change Layer')
    : (bandLabel ? `Band: ${bandLabel}` : 'Band');
  const displayedVariableLabel = isDifferenceMode
    ? `${formatVariableLabel(selectedVariable)} Change`
    : formatVariableLabel(selectedVariable);

  return (
    <>
      <aside className="sidebar">
        <div className="outcome-panel">
          <h3>Outcome Module</h3>
          <div className="outcome-name">{meta?.label || outcome?.label || 'Long Term Hotspot Analysis'}</div>
          <p>
            {meta?.description || outcome?.description || 'Precomputed ERA5 spatial maps and saved later-minus-earlier change maps.'}
          </p>
          <div className="outcome-meta-item">
            <span>Total rows:</span>
            <strong>{Number(meta?.row_count || 0).toLocaleString()}</strong>
          </div>
          <div className="outcome-meta-item">
            <span>Unique points:</span>
            <strong>{Number(meta?.point_count || 0).toLocaleString()}</strong>
          </div>
          <div className="outcome-meta-item">
            <span>Change rows:</span>
            <strong>{Number(meta?.difference_row_count || 0).toLocaleString()}</strong>
          </div>
        </div>

        <div className="variable-panel">
          <h3>Variable</h3>
          {(meta?.variables || []).map((variable) => (
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

        <div className="outcome-panel">
          <h3>Map Layer</h3>
          <div className="outcome-mode-switch">
            <button
              type="button"
              className={`outcome-mode-btn ${viewMode === 'mean' ? 'active' : ''}`}
              onClick={() => setViewMode('mean')}
            >
              Band Value
            </button>
            <button
              type="button"
              className={`outcome-mode-btn ${viewMode === 'difference' ? 'active' : ''}`}
              onClick={() => setViewMode('difference')}
              disabled={!selectedComparisonId}
              title={!selectedComparisonId ? 'Generate band difference outputs first' : 'Show later minus earlier change'}
            >
              Change
            </button>
          </div>
          <p>
            {isDifferenceMode
              ? `Displays later band ${selectedAggregation} minus earlier band ${selectedAggregation}.`
              : `Displays the ${selectedAggregation} value for one saved band.`}
          </p>
        </div>

        {viewMode === 'mean' && (
          <div className="outcome-panel">
            <h3>Base Band</h3>
            <div className="outcome-band-options">
              {(meta?.bands || []).map((band) => (
                <label className="outcome-band-option" key={band.id}>
                  <input
                    type="checkbox"
                    checked={String(selectedBandId) === String(band.id)}
                    disabled={!availableBandIds.has(String(band.id))}
                    onChange={() => setSelectedBandId(String(band.id))}
                  />
                  <span>{band.label}{!availableBandIds.has(String(band.id)) ? ' (unavailable)' : ''}</span>
                </label>
              ))}
            </div>
            {(selectedCoverage?.missing_years || []).length > 0 && (
              <p>
                Missing source year(s): {selectedCoverage.missing_years.join(', ')}. Values use available samples only.
              </p>
            )}
          </div>
        )}

        {viewMode === 'difference' && (
          <div className="outcome-panel">
            <h3>Change Pair</h3>
            <div className="outcome-band-options">
              {(meta?.comparisons || []).map((comparison) => (
                <label className="outcome-band-option" key={comparison.id}>
                  <input
                    type="checkbox"
                    checked={String(selectedComparisonId) === String(comparison.id)}
                    disabled={
                      !availableBandIds.has(String(comparison.earlier_band_id))
                      || !availableBandIds.has(String(comparison.later_band_id))
                    }
                    onChange={() => setSelectedComparisonId(String(comparison.id))}
                  />
                  <span>
                    {comparison.label}
                    {(!availableBandIds.has(String(comparison.earlier_band_id))
                      || !availableBandIds.has(String(comparison.later_band_id))) ? ' (unavailable)' : ''}
                  </span>
                </label>
              ))}
              {(meta?.comparisons || []).length === 0 && (
                <div className="outcome-empty-text">
                  No saved difference layers found. Run <code>python compute_band_differences.py</code>.
                </div>
              )}
            </div>
          </div>
        )}

        {isDifferenceMode && selectedComparison && (
          <div className="outcome-panel">
            <h3>Difference Logic</h3>
            <div className="outcome-meta-item">
              <span>Earlier layer:</span>
              <strong>{selectedComparison.earlier_band_label}</strong>
            </div>
            <div className="outcome-meta-item">
              <span>Later layer:</span>
              <strong>{selectedComparison.later_band_label}</strong>
            </div>
            <p>
              Positive values mean the later period is higher. Negative values mean the later period is lower.
            </p>
          </div>
        )}

        <div className="info-panel">
          <h3>Selection Summary</h3>
          <div className="info-item">
            <span className="label">Variable:</span>
            <span className="value">{formatVariableLabel(selectedVariable)}</span>
          </div>
          <div className="info-item">
            <span className="label">Aggregation:</span>
            <span className="value">{aggregationLabel}</span>
          </div>
          <div className="info-item">
            <span className="label">{isDifferenceMode ? 'Comparison:' : 'Band:'}</span>
            <span className="value">{isDifferenceMode ? (comparisonLabel || 'N/A') : (bandLabel || 'N/A')}</span>
          </div>
          <div className="info-item">
            <span className="label">Data Points:</span>
            <span className="value">{mapData.length.toLocaleString()}</span>
          </div>
          {stats && (
            <>
              <div className="info-item">
                <span className="label">{isDifferenceMode ? 'Min Change:' : `Min ${aggregationLabel}:`}</span>
                <span className="value">
                  {Number.isFinite(isDifferenceMode ? stats.min_change : stats.min)
                    ? (isDifferenceMode ? stats.min_change : stats.min).toFixed(3)
                    : 'N/A'}
                </span>
              </div>
              <div className="info-item">
                <span className="label">{isDifferenceMode ? 'Max Change:' : `Max ${aggregationLabel}:`}</span>
                <span className="value">
                  {Number.isFinite(isDifferenceMode ? stats.max_change : stats.max)
                    ? (isDifferenceMode ? stats.max_change : stats.max).toFixed(3)
                    : 'N/A'}
                </span>
              </div>
              <div className="info-item">
                <span className="label">{isDifferenceMode ? 'Mean Change:' : 'Basin Mean:'}</span>
                <span className="value">
                  {Number.isFinite(isDifferenceMode ? stats.mean_change : stats.mean)
                    ? (isDifferenceMode ? stats.mean_change : stats.mean).toFixed(3)
                    : 'N/A'}
                </span>
              </div>
              {isDifferenceMode && (
                <>
                  <div className="info-item">
                    <span className="label">Mean Abs Change:</span>
                    <span className="value">{Number.isFinite(stats.mean_abs_change) ? stats.mean_abs_change.toFixed(3) : 'N/A'}</span>
                  </div>
                  <div className="info-item">
                    <span className="label">Positive Points:</span>
                    <span className="value">{Number(stats.positive_points || 0).toLocaleString()}</span>
                  </div>
                  <div className="info-item">
                    <span className="label">Negative Points:</span>
                    <span className="value">{Number(stats.negative_points || 0).toLocaleString()}</span>
                  </div>
                </>
              )}
            </>
          )}
          {dataLoading && <div className="outcome-loading-text">Loading map from precomputed output...</div>}
          {dataError && <div className="outcome-error-text">{dataError}</div>}
        </div>
      </aside>

      <main className="main-content">
        <div className="map-container">
          <MapView
            data={mapData}
            currentDate={mapTitle}
            theme={theme}
            variableLabel={displayedVariableLabel}
          />
        </div>
        <div className="outcome-footnote">
          Source: saved parquet outputs in <code>{meta?.output_directory || 'Outcomes/Long_term_hotspot/Outputs'}</code>. Difference layers are saved as later band value minus earlier band value.
        </div>
      </main>
    </>
  );
}

export default React.memo(OutcomeLongTermHotspotPage);
