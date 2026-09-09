import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import apiService from '../services/api';
import './ResearchToolkitPanel.css';

const METHOD_GROUPS = [
  {
    label: 'Characterize',
    methods: [
      ['descriptive', 'Coverage & distribution'],
      ['trend', 'Robust trend + inference'],
      ['anomaly', 'Baseline anomalies'],
    ],
  },
  {
    label: 'Detect change',
    methods: [
      ['emergence', 'Persistent emergence'],
      ['change_point', 'FDR change points'],
    ],
  },
  {
    label: 'Test relations',
    methods: [
      ['relationships', 'Spatial, regional & lag relations'],
      ['compound', 'Joint anomaly footprint'],
    ],
  },
];

const AGGREGATIONS = [
  ['mean', 'Mean'],
  ['sum', 'Sum'],
  ['min', 'Minimum'],
  ['max', 'Maximum'],
  ['median', 'Median'],
];

const numberText = (value, digits = 2) => {
  if (value === null || value === undefined || value === '') return '—';
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
};

const errorText = (error) => (
  error?.response?.data?.detail || error?.message || 'The research analysis could not be completed.'
);

const variableLabel = (value) => String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());

const MiniSeriesChart = ({ rows, variable }) => {
  const points = useMemo(() => (rows || [])
    .map((row) => ({ x: Number(row.year), y: Number(row.value) }))
    .filter((row) => Number.isFinite(row.x) && Number.isFinite(row.y)), [rows]);
  if (points.length < 2) return <div className="research-empty">No continuous regional series is available.</div>;
  const width = 760;
  const height = 210;
  const pad = { left: 54, right: 18, top: 18, bottom: 36 };
  const xMin = Math.min(...points.map((point) => point.x));
  const xMax = Math.max(...points.map((point) => point.x));
  const yMin = Math.min(...points.map((point) => point.y));
  const yMax = Math.max(...points.map((point) => point.y));
  const xScale = (value) => pad.left + ((value - xMin) / Math.max(1, xMax - xMin)) * (width - pad.left - pad.right);
  const yScale = (value) => height - pad.bottom - ((value - yMin) / Math.max(1e-9, yMax - yMin)) * (height - pad.top - pad.bottom);
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${xScale(point.x)} ${yScale(point.y)}`).join(' ');
  return (
    <div className="research-series-wrap">
      <svg className="research-series-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${variable} annual regional series`}>
        {[0, 0.5, 1].map((fraction) => {
          const y = pad.top + fraction * (height - pad.top - pad.bottom);
          const value = yMax - fraction * (yMax - yMin);
          return (
            <g key={fraction}>
              <line x1={pad.left} x2={width - pad.right} y1={y} y2={y} className="research-chart-grid" />
              <text x={pad.left - 8} y={y + 4} textAnchor="end">{numberText(value, 1)}</text>
            </g>
          );
        })}
        <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} className="research-chart-axis" />
        <path d={path} className="research-chart-line" />
        {points.map((point) => <circle key={`${point.x}-${point.y}`} cx={xScale(point.x)} cy={yScale(point.y)} r="2.2" />)}
        <text x={pad.left} y={height - 10}>{xMin}</text>
        <text x={width - pad.right} y={height - 10} textAnchor="end">{xMax}</text>
      </svg>
    </div>
  );
};

function ResearchToolkitPanel({
  datasets,
  datasetId,
  datasetLabel,
  variables,
  selectedVariable,
  comparisonVariables,
  yearRange,
  selectedElevRange,
  selectedSubregionId,
  selectedSubregionLabel,
  selectedAoi,
  onClose,
  onMapOutputChange,
  initialWorkspaceState = null,
  onWorkspaceStateChange = null,
  outputPortalTargetId,
  panelWidth,
}) {
  const defaultVariables = useMemo(() => (
    Array.from(new Set([selectedVariable, ...(comparisonVariables || [])])).filter(Boolean).slice(0, 4)
  ), [comparisonVariables, selectedVariable]);
  const [specs, setSpecs] = useState(() => initialWorkspaceState?.specs || defaultVariables.map((variable, index) => ({
    id: `${Date.now()}-${index}`,
    dataset: datasetId,
    variable,
    aggregation: 'mean',
    direction: 'positive',
  })));
  const [variableOptions, setVariableOptions] = useState({ [datasetId]: variables || [] });
  const [methods, setMethods] = useState(() => initialWorkspaceState?.methods || ['descriptive', 'trend', 'anomaly']);
  const [period, setPeriod] = useState(() => initialWorkspaceState?.period || ({
    start: yearRange?.start || 1981,
    end: yearRange?.end || 2025,
    baselineStart: yearRange?.start || 1981,
    baselineEnd: Math.min(yearRange?.end || 2025, (yearRange?.start || 1981) + 29),
    recentStart: Math.max(yearRange?.start || 1981, (yearRange?.end || 2025) - 14),
  }));
  const [advancedOpen, setAdvancedOpen] = useState(() => Boolean(initialWorkspaceState?.advancedOpen));
  const [settings, setSettings] = useState(() => initialWorkspaceState?.settings || ({ anomaly: 1, emergence: 0.75, window: 9, persistence: 0.8 }));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(() => initialWorkspaceState?.result || null);
  const [error, setError] = useState('');
  const [activeLayer, setActiveLayer] = useState(() => Number(initialWorkspaceState?.activeLayer) || 0);
  const [outputTab, setOutputTab] = useState(() => initialWorkspaceState?.outputTab || 'overview');
  const [outputPortalTarget, setOutputPortalTarget] = useState(null);
  const [figureLoading, setFigureLoading] = useState('');
  const [figures, setFigures] = useState(() => initialWorkspaceState?.figures || []);
  const abortRef = useRef(null);
  const contextRef = useRef('');
  const contextSignature = useMemo(() => JSON.stringify({
    datasetId,
    selectedVariable,
    yearRange,
    selectedElevRange,
    selectedSubregionId,
    selectedAoiId: selectedAoi?.id || '',
  }), [datasetId, selectedAoi, selectedElevRange, selectedSubregionId, selectedVariable, yearRange]);

  useEffect(() => {
    onWorkspaceStateChange?.({ specs, methods, period, advancedOpen, settings, outputTab, result, activeLayer, figures });
  }, [activeLayer, advancedOpen, figures, methods, onWorkspaceStateChange, outputTab, period, result, settings, specs]);

  useLayoutEffect(() => {
    if (!outputPortalTargetId) {
      setOutputPortalTarget(null);
      return;
    }
    const updateTarget = () => setOutputPortalTarget(document.getElementById(outputPortalTargetId));
    updateTarget();
    const frame = window.requestAnimationFrame(updateTarget);
    return () => window.cancelAnimationFrame(frame);
  }, [outputPortalTargetId]);

  useEffect(() => {
    setVariableOptions((current) => ({ ...current, [datasetId]: variables || [] }));
  }, [datasetId, variables]);

  useEffect(() => {
    if (contextRef.current && contextRef.current !== contextSignature) {
      abortRef.current?.abort?.();
      setResult(null);
      setFigures([]);
      setError('Dashboard selection changed. Run the methods again to keep outputs reproducible.');
      onMapOutputChange(null);
    }
    contextRef.current = contextSignature;
  }, [contextSignature, onMapOutputChange]);

  useEffect(() => {
    setSpecs((current) => {
      if (!current.length) {
        return [{ id: `${Date.now()}-response`, dataset: datasetId, variable: selectedVariable, aggregation: 'mean', direction: 'positive' }];
      }
      const next = [...current];
      next[0] = { ...next[0], dataset: datasetId, variable: selectedVariable };
      return next;
    });
  }, [datasetId, selectedVariable]);

  useEffect(() => {
    setPeriod((current) => {
      if (!yearRange?.start || !yearRange?.end) return current;
      return {
        start: yearRange.start,
        end: yearRange.end,
        baselineStart: yearRange.start,
        baselineEnd: Math.min(yearRange.end, yearRange.start + 29),
        recentStart: Math.max(yearRange.start, yearRange.end - 14),
      };
    });
  }, [yearRange?.end, yearRange?.start]);

  useEffect(() => {
    const missing = Array.from(new Set(specs.map((spec) => spec.dataset)))
      .filter((id) => id && !variableOptions[id]);
    if (!missing.length) return undefined;
    let cancelled = false;
    Promise.all(missing.map(async (id) => {
      const response = await apiService.getAvailableVariables(id, yearRange);
      return [id, response.variables || []];
    })).then((entries) => {
      if (!cancelled) setVariableOptions((current) => ({ ...current, ...Object.fromEntries(entries) }));
    }).catch((requestError) => {
      if (!cancelled) setError(`Could not load related-variable choices: ${errorText(requestError)}`);
    });
    return () => { cancelled = true; };
  }, [specs, variableOptions, yearRange]);

  useEffect(() => {
    setSpecs((current) => current.map((spec) => {
      if (spec.variable) return spec;
      const options = variableOptions[spec.dataset] || [];
      return options.length ? { ...spec, variable: options[0] } : spec;
    }));
  }, [variableOptions]);

  const publishLayer = useCallback((layer) => {
    if (!layer?.data?.length) {
      onMapOutputChange(null);
      return;
    }
    const diverging = ['trend', 'anomaly'].includes(layer.id) || layer.id.startsWith('relationship_');
    onMapOutputChange({
      data: layer.data,
      label: layer.label,
      style: {
        palette: diverging ? 'scientific_diverging' : 'viridis',
        opacity: 0.84,
        vmin: layer.min,
        vmax: layer.max,
      },
      layer,
      meta: { run_id: result?.run_id, framework: 'guided-research' },
    });
  }, [onMapOutputChange, result?.run_id]);

  useEffect(() => {
    const layer = result?.layers?.[activeLayer];
    if (layer) publishLayer(layer);
  }, [activeLayer, publishLayer, result]);

  useEffect(() => () => {
    abortRef.current?.abort?.();
    onMapOutputChange(null);
  }, [onMapOutputChange]);

  const updateSpec = useCallback((id, field, value) => {
    setSpecs((current) => current.map((spec) => {
      if (spec.id !== id) return spec;
      if (field !== 'dataset') return { ...spec, [field]: value };
      const options = variableOptions[value] || [];
      return { ...spec, dataset: value, variable: options[0] || '' };
    }));
  }, [variableOptions]);

  const addVariable = useCallback(() => {
    if (specs.length >= 4) return;
    const fallbackDataset = datasetId || datasets.find((item) => item.ready)?.id || '';
    const options = variableOptions[fallbackDataset] || variables || [];
    setSpecs((current) => [...current, {
      id: `${Date.now()}-${current.length}`,
      dataset: fallbackDataset,
      variable: options.find((option) => !current.some((item) => item.dataset === fallbackDataset && item.variable === option)) || options[0] || '',
      aggregation: 'mean',
      direction: 'positive',
    }]);
  }, [datasetId, datasets, specs.length, variableOptions, variables]);

  const toggleMethod = useCallback((method) => {
    setMethods((current) => current.includes(method) ? current.filter((item) => item !== method) : [...current, method]);
  }, []);

  const runAnalysis = useCallback(async () => {
    if (!specs.length || specs.some((spec) => !spec.dataset || !spec.variable)) {
      setError('Choose a valid dataset and variable for every research role.');
      return;
    }
    if (!methods.length) {
      setError('Select at least one analysis method.');
      return;
    }
    abortRef.current?.abort?.();
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError('');
    setFigures([]);
    onMapOutputChange(null);
    try {
      const payload = {
        variables: specs.map(({ dataset, variable, aggregation, direction }) => ({ dataset, variable, aggregation, direction })),
        year_start: Number(period.start),
        year_end: Number(period.end),
        baseline_start: Number(period.baselineStart),
        baseline_end: Number(period.baselineEnd),
        recent_start: Number(period.recentStart),
        elev_min: Number(selectedElevRange?.min ?? 0),
        elev_max: Number(selectedElevRange?.max ?? 9000),
        subregion_id: selectedAoi ? null : (selectedSubregionId || null),
        aoi_geojson: selectedAoi?.geometry ? {
          type: 'Feature',
          properties: {
            id: selectedAoi.id,
            label: selectedAoi.name || selectedAoi.label || 'ROI',
          },
          geometry: selectedAoi.geometry,
        } : null,
        methods,
        anomaly_threshold: Number(settings.anomaly),
        emergence_threshold: Number(settings.emergence),
        emergence_window: Number(settings.window),
        persistence_fraction: Number(settings.persistence),
      };
      const response = await apiService.runResearchFramework(payload, controller.signal);
      setResult(response);
      setActiveLayer(0);
      setOutputTab('overview');
      if (response.layers?.[0]) publishLayer(response.layers[0]);
    } catch (requestError) {
      if (requestError?.name !== 'CanceledError' && requestError?.code !== 'ERR_CANCELED') setError(errorText(requestError));
    } finally {
      setRunning(false);
    }
  }, [methods, onMapOutputChange, period, publishLayer, selectedAoi, selectedElevRange, selectedSubregionId, settings, specs]);

  const createFigure = useCallback(async (figureType) => {
    if (!result?.run_id) return;
    setFigureLoading(figureType);
    setError('');
    try {
      const figure = await apiService.createResearchFrameworkFigure({
        figure_type: figureType,
        run_id: result.run_id,
        dpi: 600,
      });
      setFigures((current) => [figure, ...current.filter((item) => item.figure_type !== figure.figure_type)]);
    } catch (requestError) {
      setError(errorText(requestError));
    } finally {
      setFigureLoading('');
    }
  }, [result?.run_id]);

  const responseVariable = specs[0];
  const resultOutput = result && (
    <div className="research-output-shell">
      <div className="research-output-tabs" role="tablist" aria-label="Research outputs">
        {[
          ['overview', 'Overview'],
          ['series', 'Series'],
          ['relationships', 'Relations'],
          ['figures', 'Figures'],
          ['exports', 'Exports'],
        ].map(([id, label]) => (
          <button key={id} type="button" className={outputTab === id ? 'active' : ''} onClick={() => setOutputTab(id)}>{label}</button>
        ))}
      </div>
      <div className="research-output-content">
        {outputTab === 'overview' && (
          <>
            <div className="research-output-heading">
              <div>
                <span className="research-kicker">Derived run {result.run_id}</span>
                <h3>{result.variable?.label}</h3>
              </div>
              <span>{result.coverage?.year_count} years · {Number(result.coverage?.pixel_count || 0).toLocaleString()} pixels</span>
            </div>
            <div className="research-metric-grid">
              <div><span>Sen trend / decade</span><strong>{numberText(result.headline?.regional_sen_slope_per_decade, 3)}</strong></div>
              <div><span>HAC p-value</span><strong>{numberText(result.headline?.regional_hac_p, 3)}</strong></div>
              <div><span>Recent anomaly</span><strong>{numberText(result.headline?.recent_mean_anomaly_z, 2)} SD</strong></div>
              <div><span>FDR trend area</span><strong>{numberText(result.headline?.spatial_fdr_trend_area_percent, 1)}%</strong></div>
              <div><span>Emergent area</span><strong>{numberText(result.headline?.persistent_emerged_area_percent, 1)}%</strong></div>
              <div><span>Median shift</span><strong>{result.headline?.median_fdr_change_year || '—'}</strong></div>
            </div>
            <div className="research-layer-row">
              {(result.layers || []).map((layer, index) => (
                <button key={layer.id} type="button" className={activeLayer === index ? 'active' : ''} onClick={() => setActiveLayer(index)}>
                  {layer.label}
                </button>
              ))}
            </div>
            <div className="research-guardrail">{result.interpretation_guardrails?.[0]}</div>
          </>
        )}
        {outputTab === 'series' && <MiniSeriesChart rows={result.annual_series} variable={result.variable?.label} />}
        {outputTab === 'relationships' && (
          <div className="research-relations-grid">
            {(result.relationships || []).map((relation) => (
              <article key={relation.key}>
                <span>{relation.dataset?.label}</span>
                <h4>{relation.variable?.label}</h4>
                <dl>
                  <div><dt>Pearson r</dt><dd>{numberText(relation.regional?.pearson_r, 2)}</dd></div>
                  <div><dt>Spearman ρ</dt><dd>{numberText(relation.regional?.spearman_rho, 2)}</dd></div>
                  <div><dt>Spatial r</dt><dd>{numberText(relation.spatial?.pearson_r, 2)}</dd></div>
                  <div><dt>Best lag</dt><dd>{relation.regional?.strongest_lag_years ?? '—'} yr</dd></div>
                  <div><dt>Local FDR area</dt><dd>{numberText(relation.local?.fdr_significant_area_percent, 1)}%</dd></div>
                </dl>
                <small>Nearest-grid median offset {numberText(relation.harmonization?.median_offset_degrees, 3)}°</small>
              </article>
            ))}
            {!result.relationships?.length && <div className="research-empty">Add a related variable to test regional, lagged, and spatial relations.</div>}
          </div>
        )}
        {outputTab === 'figures' && (
          <div className="research-figure-output">
            <div className="research-figure-actions">
              {['diagnostic_atlas', 'timeseries', ...(result.relationships?.length ? ['relationship'] : [])].map((type) => (
                <button key={type} type="button" disabled={Boolean(figureLoading)} onClick={() => createFigure(type)}>
                  {figureLoading === type ? 'Rendering…' : `Create ${type.replaceAll('_', ' ')}`}
                </button>
              ))}
            </div>
            {figures.map((figure) => (
              <article key={figure.figure_type}>
                <img src={apiService.getResearchArtifactUrl(figure.formats.png)} alt={`${figure.figure_type} research figure`} />
                <div>
                  <strong>{figure.figure_type.replaceAll('_', ' ')}</strong>
                  {Object.entries(figure.formats).map(([format, path]) => (
                    <a key={format} href={apiService.getResearchArtifactUrl(path)} target="_blank" rel="noreferrer">{format.toUpperCase()}</a>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
        {outputTab === 'exports' && (
          <div className="research-export-grid">
            {Object.entries(result.exports || {}).map(([name, path]) => (
              <a key={name} href={apiService.getResearchArtifactUrl(path)} target="_blank" rel="noreferrer">
                <strong>{name.replaceAll('_', ' ')}</strong><span>Download derived artifact</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <aside className="research-toolkit" style={panelWidth ? { width: panelWidth, flexBasis: panelWidth } : undefined}>
      <header className="research-toolkit-header">
        <div><span>Guided methods</span><h2>Research toolkit</h2></div>
        <button type="button" onClick={onClose} aria-label="Close research toolkit">Close</button>
      </header>
      <div className="research-toolkit-body">
        <section className="research-context-card">
          <span>Using dashboard selection</span>
          <strong>{datasetLabel}</strong>
          <p>{period.start}–{period.end} · {selectedElevRange?.min}–{selectedElevRange?.max} m</p>
          <div>
            {selectedSubregionLabel && <em>{selectedSubregionLabel}</em>}
            {!selectedSubregionLabel && selectedAoi && <em>{selectedAoi.name || 'ROI'}</em>}
            {!selectedSubregionLabel && !selectedAoi && <em>full visible study domain</em>}
          </div>
        </section>

        <section className="research-tool-section">
          <div className="research-section-title"><span>1</span><div><h3>Define variable roles</h3><p>The response stays linked to the dashboard. Add any related dataset-variable pair.</p></div></div>
          {specs.map((spec, index) => (
            <div className="research-variable-card" key={spec.id}>
              <div className="research-variable-role">
                <strong>{index === 0 ? 'Response variable' : `Related variable ${index}`}</strong>
                {index > 0 && <button type="button" onClick={() => setSpecs((current) => current.filter((item) => item.id !== spec.id))}>Remove</button>}
              </div>
              {index > 0 && (
                <label>Dataset<select value={spec.dataset} onChange={(event) => updateSpec(spec.id, 'dataset', event.target.value)}>
                  {datasets.filter((dataset) => dataset.ready).map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.label}</option>)}
                </select></label>
              )}
              <label>Variable<select value={spec.variable} onChange={(event) => updateSpec(spec.id, 'variable', event.target.value)}>
                {(variableOptions[spec.dataset] || []).map((variable) => <option key={variable} value={variable}>{variableLabel(variable)}</option>)}
              </select></label>
              <div className="research-inline-fields">
                <label>Annual reducer<select value={spec.aggregation} onChange={(event) => updateSpec(spec.id, 'aggregation', event.target.value)}>
                  {AGGREGATIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                </select></label>
                <label>Signal direction<select value={spec.direction} onChange={(event) => updateSpec(spec.id, 'direction', event.target.value)}>
                  <option value="positive">Higher is signal</option><option value="negative">Lower is signal</option>
                </select></label>
              </div>
            </div>
          ))}
          <button className="research-add-variable" type="button" disabled={specs.length >= 4} onClick={addVariable}>+ Add related variable</button>
        </section>

        <section className="research-tool-section">
          <div className="research-section-title"><span>2</span><div><h3>Choose the analytical lens</h3><p>Methods are reusable across every numeric variable.</p></div></div>
          {METHOD_GROUPS.map((group) => (
            <div className="research-method-group" key={group.label}>
              <span>{group.label}</span>
              {group.methods.map(([id, label]) => (
                <label key={id}><input type="checkbox" checked={methods.includes(id)} onChange={() => toggleMethod(id)} /><span>{label}</span></label>
              ))}
            </div>
          ))}
        </section>

        <section className="research-tool-section">
          <div className="research-section-title"><span>3</span><div><h3>Set inference periods</h3><p>Analysis period is inherited and remains editable.</p></div></div>
          <div className="research-period-grid">
            <label>Start<input type="number" value={period.start} onChange={(event) => setPeriod((current) => ({ ...current, start: event.target.value }))} /></label>
            <label>End<input type="number" value={period.end} onChange={(event) => setPeriod((current) => ({ ...current, end: event.target.value }))} /></label>
            <label>Baseline start<input type="number" value={period.baselineStart} onChange={(event) => setPeriod((current) => ({ ...current, baselineStart: event.target.value }))} /></label>
            <label>Baseline end<input type="number" value={period.baselineEnd} onChange={(event) => setPeriod((current) => ({ ...current, baselineEnd: event.target.value }))} /></label>
            <label>Recent period starts<input type="number" value={period.recentStart} onChange={(event) => setPeriod((current) => ({ ...current, recentStart: event.target.value }))} /></label>
          </div>
          <button className="research-advanced-toggle" type="button" onClick={() => setAdvancedOpen((current) => !current)}>{advancedOpen ? 'Hide' : 'Show'} reproducibility thresholds</button>
          {advancedOpen && (
            <div className="research-period-grid advanced">
              <label>Anomaly SD<input type="number" step="0.1" value={settings.anomaly} onChange={(event) => setSettings((current) => ({ ...current, anomaly: event.target.value }))} /></label>
              <label>Emergence SD<input type="number" step="0.05" value={settings.emergence} onChange={(event) => setSettings((current) => ({ ...current, emergence: event.target.value }))} /></label>
              <label>Window years<input type="number" step="2" min="5" max="15" value={settings.window} onChange={(event) => setSettings((current) => ({ ...current, window: event.target.value }))} /></label>
              <label>Persistence<input type="number" step="0.05" min="0.5" max="1" value={settings.persistence} onChange={(event) => setSettings((current) => ({ ...current, persistence: event.target.value }))} /></label>
            </div>
          )}
        </section>

        {error && <div className="research-tool-error" role="alert">{error}</div>}
        <button className="research-run-button" type="button" disabled={running || !responseVariable?.variable} onClick={runAnalysis}>
          {running ? <><span className="research-run-spinner" />Aggregating and testing…</> : 'Run guided research analysis'}
        </button>
        <p className="research-source-note">Read-only source access · derived outputs saved separately · harmonization reported</p>
        {result && !outputPortalTarget && resultOutput}
      </div>
      {outputPortalTarget && result ? createPortal(resultOutput, outputPortalTarget) : null}
    </aside>
  );
}

export default ResearchToolkitPanel;
