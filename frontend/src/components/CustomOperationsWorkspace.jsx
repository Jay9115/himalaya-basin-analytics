import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import MapView from './MapView';
import OperationChartRenderer from './OperationChartRenderer';
import apiService from '../services/api';
import './CustomOperationsWorkspace.css';

loader.config({ monaco });

const DEFAULT_CODE = `def run(hb, df, meta):
    if meta.get("large_mode"):
        annual = hb.sql("""
            SELECT year(date)::INTEGER AS year, avg(value) AS value_mean
            FROM data
            GROUP BY year
            ORDER BY year
        """)
        hb.text(f"{meta['dataset_label']} large analysis rows: {meta['row_count']}")
        hb.table(annual, name="annual_mean")
        hb.chart(annual, chart_type="line", x="year", y="value_mean", name="annual_mean_chart")
        hb.export_csv(annual, filename="annual_mean.csv")
        return

    daily = df.groupby("date", as_index=False)["value"].mean()
    hb.text(f"{meta['dataset_label']} rows: {len(df)}")
    hb.number("mean_value", df["value"].mean())
    hb.table(daily, name="daily_mean")
    hb.chart(daily, chart_type="line", x="date", y="value", name="daily_mean_chart")
    hb.map_points(df, name="selected_data", style={"palette": "viridis", "radius": 4})
    hb.export_csv(daily, filename="daily_mean.csv")
`;

const clampYearRange = (range, years) => {
  if (!years.length) return { start: null, end: null };
  const minYear = years[0];
  const maxYear = years[years.length - 1];
  const startRaw = Number.isInteger(range?.start) ? range.start : minYear;
  const endRaw = Number.isInteger(range?.end) ? range.end : Math.min(minYear + 1, maxYear);
  const start = Math.min(maxYear, Math.max(minYear, startRaw));
  const end = Math.min(maxYear, Math.max(minYear, endRaw));
  return { start: Math.min(start, end), end: Math.max(start, end) };
};

const valueFromTableRow = (columns, row, key) => {
  const index = columns.indexOf(key);
  return index >= 0 ? row[index] : undefined;
};

const tableRowsToObjects = (output) => {
  const columns = output?.columns || [];
  return (output?.rows || []).map((row, rowIndex) => {
    const item = { __rowIndex: rowIndex };
    columns.forEach((column, columnIndex) => {
      item[column] = row[columnIndex];
    });
    return item;
  });
};

const normalizeMapOutput = (output) => {
  if (!output) return [];
  if (output.layer_type === 'geojson') {
    return output.feature_collection?.features || [];
  }
  return output.features || [];
};

const stringifyTerminalPayload = (value) => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const buildTerminalFailure = ({ status = 'error', error, response, command }) => {
  const lines = [];
  if (command) lines.push(`> ${command}`);
  lines.push(`[${status}]`);
  const message = stringifyTerminalPayload(error);
  if (message) lines.push(message);
  const rawResponse = stringifyTerminalPayload(response);
  if (rawResponse) {
    lines.push('raw response:');
    lines.push(rawResponse);
  }
  return {
    ok: false,
    status,
    outputs: [],
    stdout: '',
    stderr: '',
    error: lines.join('\n'),
    meta: {},
  };
};

function CustomOperationsWorkspace({
  datasets,
  initialDatasetId,
  initialYearRange,
  theme,
  onHome,
}) {
  const readyDatasets = useMemo(() => datasets.filter((dataset) => dataset.ready), [datasets]);
  const [datasetId, setDatasetId] = useState(initialDatasetId || readyDatasets[0]?.id || '');
  const [years, setYears] = useState([]);
  const [yearRange, setYearRange] = useState(initialYearRange || { start: null, end: null });
  const [dates, setDates] = useState([]);
  const [dateMode, setDateMode] = useState('single');
  const [date, setDate] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [variables, setVariables] = useState([]);
  const [variable, setVariable] = useState('');
  const [elevMin, setElevMin] = useState(500);
  const [elevMax, setElevMax] = useState(9000);
  const [timeoutSeconds, setTimeoutSeconds] = useState(15);
  const [subregions, setSubregions] = useState([]);
  const [subregionId, setSubregionId] = useState('');
  const [subregionQuery, setSubregionQuery] = useState('');
  const [code, setCode] = useState(DEFAULT_CODE);
  const [capabilities, setCapabilities] = useState(null);
  const [validation, setValidation] = useState(null);
  const [result, setResult] = useState(null);
  const [activeOutputTab, setActiveOutputTab] = useState('terminal');
  const [activeMapOutputIndex, setActiveMapOutputIndex] = useState(0);
  const [loadingContext, setLoadingContext] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [activeJobId, setActiveJobId] = useState('');
  const operationAbortRef = useRef(null);

  const selectedDataset = readyDatasets.find((dataset) => dataset.id === datasetId) || null;
  const yearMin = years.length ? years[0] : null;
  const yearMax = years.length ? years[years.length - 1] : null;
  const selectedSubregion = subregions.find((item) => item.id === subregionId) || null;
  const filteredSubregions = useMemo(() => {
    const query = subregionQuery.trim().toLowerCase();
    const matches = query
      ? subregions.filter((item) => `${item.label || ''} ${item.id || ''} ${item.kind || ''}`.toLowerCase().includes(query))
      : subregions;
    const limited = matches.slice(0, 160);
    if (selectedSubregion && !limited.some((item) => item.id === selectedSubregion.id)) {
      return [selectedSubregion, ...limited];
    }
    return limited;
  }, [selectedSubregion, subregionQuery, subregions]);

  const mapOutputs = useMemo(
    () => (result?.outputs || []).filter((output) => output.type === 'map_layer'),
    [result]
  );
  const tableOutputs = useMemo(
    () => (result?.outputs || []).filter((output) => output.type === 'table'),
    [result]
  );
  const chartOutputs = useMemo(
    () => (result?.outputs || []).filter((output) => output.type === 'chart'),
    [result]
  );
  const numberOutputs = useMemo(
    () => (result?.outputs || []).filter((output) => output.type === 'number' || output.type === 'result'),
    [result]
  );
  const textOutputs = useMemo(
    () => (result?.outputs || []).filter((output) => output.type === 'text'),
    [result]
  );
  const exportOutputs = useMemo(
    () => (result?.outputs || []).filter((output) => output.type === 'export_file'),
    [result]
  );
  const activeMapOutput = mapOutputs[Math.min(activeMapOutputIndex, Math.max(0, mapOutputs.length - 1))];
  const mapData = useMemo(() => normalizeMapOutput(activeMapOutput), [activeMapOutput]);
  const terminalText = useMemo(() => {
    const blocks = [];
    if (result?.job_id) blocks.push(`job: ${result.job_id}`);
    if (result?.status) blocks.push(`status: ${result.status}`);
    if (result?.plan?.execution_mode) blocks.push(`plan: ${result.plan.execution_mode}`);
    if (result?.progress) {
      const progress = result.progress;
      const pieces = [
        progress.phase ? `phase=${progress.phase}` : '',
        progress.date_count ? `dates=${progress.dates_processed || 0}/${progress.date_count}` : '',
        progress.chunk_count ? `chunks=${progress.chunks_processed ?? progress.chunk_count}/${progress.chunk_count}` : '',
        progress.rows_materialized ? `rows=${Number(progress.rows_materialized).toLocaleString()}` : '',
      ].filter(Boolean);
      if (pieces.length) blocks.push(`progress: ${pieces.join(' | ')}`);
    }
    if (result?.stdout) blocks.push(result.stdout);
    for (const output of textOutputs) {
      blocks.push(String(output.value || ''));
    }
    if (result?.stderr) blocks.push(`stderr:\n${result.stderr}`);
    if (result?.error) blocks.push(`error:\n${result.error}`);
    if (!blocks.length && result) blocks.push(JSON.stringify(result.meta || {}, null, 2));
    return blocks.join('\n\n');
  }, [result, textOutputs]);

  useEffect(() => {
    if (initialDatasetId) {
      setDatasetId(initialDatasetId);
    } else if (!datasetId && readyDatasets.length) {
      setDatasetId(readyDatasets[0].id);
    }
  }, [datasetId, initialDatasetId, readyDatasets]);

  useEffect(() => {
    let active = true;
    apiService.getOperationCapabilities()
      .then((payload) => {
        if (active) setCapabilities(payload);
      })
      .catch(() => {
        if (active) setCapabilities(null);
      });
    apiService.getSubregions()
      .then((payload) => {
        if (active) setSubregions(payload.subregions || []);
      })
      .catch(() => {
        if (active) setSubregions([]);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!datasetId) return;
    let active = true;
    const loadYears = async () => {
      try {
        setLoadingContext(true);
        setError('');
        const response = await apiService.getAvailableYears(datasetId);
        if (!active) return;
        const nextYears = (response.years || [])
          .map((item) => Number(item))
          .filter((item) => Number.isInteger(item))
          .sort((a, b) => a - b);
        setYears(nextYears);
        setYearRange((prev) => clampYearRange(prev?.start ? prev : initialYearRange, nextYears));
      } catch (err) {
        if (!active) return;
        setYears([]);
        setYearRange({ start: null, end: null });
        setError(err?.response?.data?.detail || 'Failed to load years for selected dataset.');
      } finally {
        if (active) setLoadingContext(false);
      }
    };
    loadYears();
    return () => {
      active = false;
    };
  }, [datasetId, initialYearRange]);

  useEffect(() => {
    if (!datasetId || !yearRange.start || !yearRange.end) return;
    let active = true;
    const loadContext = async () => {
      try {
        setLoadingContext(true);
        setError('');
        const range = { start: yearRange.start, end: yearRange.end };
        const [datePayload, variablePayload] = await Promise.all([
          apiService.getAvailableDates(datasetId, range),
          apiService.getAvailableVariables(datasetId, range),
        ]);
        if (!active) return;
        const nextDates = datePayload.dates || [];
        const nextVariables = variablePayload.variables || [];
        setDates(nextDates);
        setVariables(nextVariables);
        setDate((prev) => (nextDates.includes(prev) ? prev : nextDates[0] || ''));
        setStartDate((prev) => (nextDates.includes(prev) ? prev : nextDates[0] || ''));
        setEndDate((prev) => (nextDates.includes(prev) ? prev : nextDates[Math.min(6, nextDates.length - 1)] || ''));
        setVariable((prev) => (nextVariables.includes(prev) ? prev : variablePayload.default_variable || nextVariables[0] || ''));
      } catch (err) {
        if (!active) return;
        setDates([]);
        setVariables([]);
        setError(err?.response?.data?.detail || 'Failed to load dataset context.');
      } finally {
        if (active) setLoadingContext(false);
      }
    };
    loadContext();
    return () => {
      active = false;
    };
  }, [datasetId, yearRange]);

  const handleYearChange = useCallback((field, value) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || yearMin === null || yearMax === null) return;
    const clamped = Math.min(yearMax, Math.max(yearMin, parsed));
    setYearRange((prev) => {
      const currentStart = Number.isInteger(prev.start) ? prev.start : clamped;
      const currentEnd = Number.isInteger(prev.end) ? prev.end : clamped;
      if (field === 'start') {
        return { start: Math.min(clamped, currentEnd), end: Math.max(clamped, currentEnd) };
      }
      return { start: Math.min(currentStart, clamped), end: Math.max(currentStart, clamped) };
    });
  }, [yearMin, yearMax]);

  const validateCode = useCallback(async () => {
    setValidation(null);
    setError('');
    try {
      const response = await apiService.validateOperationCode(code);
      setValidation(response);
      if (!response.ok) {
        setResult(buildTerminalFailure({
          status: 'validation_error',
          command: 'POST /operations/validate',
          error: 'Code validation failed.',
          response,
        }));
        setActiveOutputTab('terminal');
      } else {
        setResult({
          ok: true,
          status: 'validation_passed',
          outputs: [],
          stdout: 'Validation passed. Ready to run.',
          stderr: '',
          error: '',
          meta: {},
        });
        setActiveOutputTab('terminal');
      }
      return response;
    } catch (err) {
      const responsePayload = err?.response?.data;
      const statusCode = err?.response?.status;
      const failure = buildTerminalFailure({
        status: statusCode ? `http_${statusCode}` : 'request_error',
        command: 'POST /operations/validate',
        error: err?.message || 'Validation request failed.',
        response: responsePayload,
      });
      setResult(failure);
      setActiveOutputTab('terminal');
      setError('Validation request failed. See terminal output.');
      return { ok: false, errors: [] };
    }
  }, [code]);

  const waitForOperationJob = useCallback(async (jobId, signal) => {
    if (!jobId) return null;
    const terminalStatuses = new Set(['completed', 'error', 'canceled', 'timeout']);
    while (!signal.aborted) {
      await new Promise((resolve, reject) => {
        const timer = window.setTimeout(resolve, 1500);
        signal.addEventListener('abort', () => {
          window.clearTimeout(timer);
          reject(new DOMException('Operation canceled', 'AbortError'));
        }, { once: true });
      });
      const payload = await apiService.getOperationJob(jobId, signal);
      setResult(payload);
      if (terminalStatuses.has(payload.status)) {
        setActiveJobId('');
        return payload;
      }
    }
    return null;
  }, []);

  const runOperation = useCallback(async () => {
    if (!datasetId || !variable) {
      setError('Choose a ready dataset and variable.');
      return;
    }
    if (dateMode === 'single' && !date) {
      setError('Choose a date.');
      return;
    }
    if (dateMode === 'range' && (!startDate || !endDate)) {
      setError('Choose a date range.');
      return;
    }

    const controller = new AbortController();
    operationAbortRef.current?.abort?.();
    operationAbortRef.current = controller;
    setRunning(true);
    setError('');
    setResult(null);
    try {
      const check = await apiService.validateOperationCode(code, controller.signal);
      setValidation(check);
      if (!check.ok) {
        const failure = buildTerminalFailure({
          status: 'validation_error',
          command: 'POST /operations/validate',
          error: 'Code validation failed before execution.',
          response: check,
        });
        setResult(failure);
        setActiveOutputTab('terminal');
        setError('Code validation failed. See terminal output.');
        return;
      }
      const selection = {
        dataset: datasetId,
        variable,
        elev_min: Number(elevMin),
        elev_max: Number(elevMax),
        year_start: yearRange.start,
        year_end: yearRange.end,
      };
      if (subregionId) selection.subregion_id = subregionId;
      if (dateMode === 'single') {
        selection.date = date;
      } else {
        selection.start_date = startDate <= endDate ? startDate : endDate;
        selection.end_date = startDate <= endDate ? endDate : startDate;
      }

      const plan = await apiService.planOperation(selection, controller.signal);
      if (!plan.can_run_inline) {
        const job = await apiService.submitOperationJob(
          {
            code,
            selection,
            timeout_seconds: Math.max(600, Number(timeoutSeconds) * 60),
          },
          controller.signal
        );
        setActiveJobId(job.job_id || '');
        setResult(job);
        setActiveOutputTab('terminal');
        const finalJob = await waitForOperationJob(job.job_id, controller.signal);
        if (finalJob) {
          setResult(finalJob);
          setActiveOutputTab(finalJob.outputs?.some((output) => output.type === 'map_layer') ? 'map' : 'terminal');
        }
      } else {
        const payload = await apiService.runOperation(
          {
            code,
            selection,
            timeout_seconds: Number(timeoutSeconds),
          },
          controller.signal
        );
        setResult(payload);
        setActiveOutputTab(payload.outputs?.some((output) => output.type === 'map_layer') ? 'map' : 'terminal');
      }
      setActiveMapOutputIndex(0);
    } catch (err) {
      const canceled = err?.name === 'CanceledError' || err?.name === 'AbortError' || err?.code === 'ERR_CANCELED';
      if (!canceled) {
        const responsePayload = err?.response?.data;
        const statusCode = err?.response?.status;
        const failure = buildTerminalFailure({
          status: statusCode ? `http_${statusCode}` : 'request_error',
          command: 'POST /operations/run',
          error: err?.message || 'Operation failed.',
          response: responsePayload,
        });
        setResult(failure);
        setActiveOutputTab('terminal');
        setError('Operation failed. See terminal output.');
      }
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }, [
    code,
    datasetId,
    date,
    dateMode,
    elevMax,
    elevMin,
    endDate,
    startDate,
    subregionId,
    timeoutSeconds,
    variable,
    waitForOperationJob,
    yearRange,
  ]);

  const cancelOperation = useCallback(() => {
    operationAbortRef.current?.abort?.();
    if (activeJobId) {
      apiService.cancelOperationJob(activeJobId)
        .then((payload) => setResult(payload))
        .catch(() => {});
      setActiveJobId('');
    }
    setRunning(false);
  }, [activeJobId]);

  return (
    <div className="code-workspace" data-theme={theme}>
      <header className="code-header">
        <div>
          <h1>HB Code Lab</h1>
          <span>{selectedDataset?.label || 'Dataset'} | {capabilities?.engine || 'sandbox'}</span>
        </div>
        <div className="code-header-actions">
          <button type="button" className="code-secondary-btn" onClick={onHome}>Home</button>
          <button type="button" className="code-secondary-btn" onClick={validateCode} disabled={running}>
            Validate
          </button>
          {running ? (
            <button type="button" className="code-danger-btn" onClick={cancelOperation}>Stop</button>
          ) : (
            <button type="button" className="code-primary-btn" onClick={runOperation}>Run</button>
          )}
        </div>
      </header>

      <div className="code-body">
        <aside className="code-context-panel">
          <section className="code-section">
            <h2>Data</h2>
            <label>
              Dataset
              <select value={datasetId} onChange={(event) => setDatasetId(event.target.value)}>
                {readyDatasets.map((dataset) => (
                  <option key={dataset.id} value={dataset.id}>{dataset.label}</option>
                ))}
              </select>
            </label>
            <label>
              Variable
              <select value={variable} onChange={(event) => setVariable(event.target.value)} disabled={!variables.length}>
                {variables.map((item) => (
                  <option key={item} value={item}>{item}</option>
                ))}
              </select>
            </label>
            <label>
              Sub-Region
              <input
                type="search"
                value={subregionQuery}
                onChange={(event) => setSubregionQuery(event.target.value)}
                placeholder="Search basin or glacier"
              />
              <select value={subregionId} onChange={(event) => setSubregionId(event.target.value)}>
                <option value="">Full selection</option>
                {filteredSubregions.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
            {selectedSubregion && (
              <div className="code-context-note">{selectedSubregion.kind || 'region'} | {selectedSubregion.id}</div>
            )}
          </section>

          <section className="code-section">
            <h2>Time</h2>
            <div className="code-toggle-group">
              <button
                type="button"
                className={dateMode === 'single' ? 'active' : ''}
                onClick={() => setDateMode('single')}
              >
                Single
              </button>
              <button
                type="button"
                className={dateMode === 'range' ? 'active' : ''}
                onClick={() => setDateMode('range')}
              >
                Range
              </button>
            </div>
            <div className="code-two-col">
              <label>
                Year Start
                <input
                  type="number"
                  value={yearRange.start ?? ''}
                  min={yearMin || undefined}
                  max={yearMax || undefined}
                  onChange={(event) => handleYearChange('start', event.target.value)}
                />
              </label>
              <label>
                Year End
                <input
                  type="number"
                  value={yearRange.end ?? ''}
                  min={yearMin || undefined}
                  max={yearMax || undefined}
                  onChange={(event) => handleYearChange('end', event.target.value)}
                />
              </label>
            </div>
            {dateMode === 'single' ? (
              <label>
                Date
                <select value={date} onChange={(event) => setDate(event.target.value)} disabled={!dates.length}>
                  {dates.map((item) => (
                    <option key={item} value={item}>{item}</option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="code-two-col">
                <label>
                  Start Date
                  <select value={startDate} onChange={(event) => setStartDate(event.target.value)} disabled={!dates.length}>
                    {dates.map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                </label>
                <label>
                  End Date
                  <select value={endDate} onChange={(event) => setEndDate(event.target.value)} disabled={!dates.length}>
                    {dates.map((item) => (
                      <option key={item} value={item}>{item}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </section>

          <section className="code-section">
            <h2>Limits</h2>
            <div className="code-two-col">
              <label>
                Elev Min
                <input type="number" value={elevMin} onChange={(event) => setElevMin(event.target.value)} />
              </label>
              <label>
                Elev Max
                <input type="number" value={elevMax} onChange={(event) => setElevMax(event.target.value)} />
              </label>
            </div>
            <div className="code-two-col">
              <label>
                Timeout
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={timeoutSeconds}
                  onChange={(event) => setTimeoutSeconds(event.target.value)}
                />
              </label>
            </div>
            <div className="code-context-note">
              {loadingContext
                ? 'Loading context...'
                : `${dates.length.toLocaleString()} dates | ${variables.length} variables`}
            </div>
          </section>
        </aside>

        <main className="code-main-panel">
          <div className="editor-shell">
            <Editor
              height="100%"
              defaultLanguage="python"
              theme={theme === 'dark' ? 'vs-dark' : 'light'}
              value={code}
              onChange={(value) => setCode(value || '')}
              options={{
                minimap: { enabled: false },
                fontSize: 13,
                lineNumbersMinChars: 3,
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                tabSize: 4,
                automaticLayout: true,
              }}
            />
          </div>
          <div className="code-status-row">
            {validation && (
              <span className={validation.ok ? 'code-status-ok' : 'code-status-error'}>
                {validation.ok ? 'Validation passed' : `${validation.errors?.length || 0} validation errors`}
              </span>
            )}
            {result && (
              <span className={result.ok ? 'code-status-ok' : 'code-status-error'}>
                {result.status} | {Number(result.duration_ms || 0).toLocaleString()} ms | {Number(result.meta?.row_count || 0).toLocaleString()} rows
              </span>
            )}
            {error && <span className="code-status-error">{String(error)}</span>}
          </div>
          {validation && !validation.ok && (
            <div className="validation-list">
              {(validation.errors || []).map((item, index) => (
                <div key={`${item.line}-${index}`}>Line {item.line || '-'}: {item.message}</div>
              ))}
            </div>
          )}
        </main>

        <aside className="code-output-panel">
          <div className="output-tabs">
            {['terminal', 'table', 'chart', 'map', 'exports'].map((tab) => (
              <button
                key={tab}
                type="button"
                className={activeOutputTab === tab ? 'active' : ''}
                onClick={() => setActiveOutputTab(tab)}
              >
                {tab}
              </button>
            ))}
          </div>

          <div className="output-content">
            {activeOutputTab === 'terminal' && (
              <div className="terminal-output">
                <pre>{terminalText || 'No output yet.'}</pre>
                {numberOutputs.length > 0 && (
                  <div className="number-grid">
                    {numberOutputs.map((output, index) => (
                      <div className="number-tile" key={`${output.name}-${index}`}>
                        <span>{output.name}</span>
                        <strong>{typeof output.value === 'number' ? output.value.toFixed(4) : JSON.stringify(output.value)}</strong>
                        {output.units && <small>{output.units}</small>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {activeOutputTab === 'table' && (
              <div className="table-output">
                {tableOutputs.length === 0 && <div className="empty-output">No tables.</div>}
                {tableOutputs.map((output, outputIndex) => (
                  <div className="table-block" key={`${output.name}-${outputIndex}`}>
                    <div className="output-title">{output.name} | {Number(output.row_count || 0).toLocaleString()} rows</div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            {(output.columns || []).map((column) => (
                              <th key={column}>{column}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(output.rows || []).slice(0, 100).map((row, rowIndex) => (
                            <tr key={rowIndex}>
                              {(output.columns || []).map((column) => (
                                <td key={column}>{String(valueFromTableRow(output.columns, row, column) ?? '')}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {activeOutputTab === 'chart' && (
              <div className="chart-output">
                {chartOutputs.length === 0 && <div className="empty-output">No charts.</div>}
                {chartOutputs.map((output, index) => {
                  return (
                    <div className="chart-block" key={`${output.name}-${index}`}>
                      <div className="output-title">{output.name} | {output.chart_type || 'line'}</div>
                      <OperationChartRenderer output={output.points ? output : { ...output, points: tableRowsToObjects(output) }} height={240} />
                    </div>
                  );
                })}
              </div>
            )}

            {activeOutputTab === 'map' && (
              <div className="map-output">
                {mapOutputs.length > 1 && (
                  <select
                    className="map-output-select"
                    value={activeMapOutputIndex}
                    onChange={(event) => setActiveMapOutputIndex(Number(event.target.value))}
                  >
                    {mapOutputs.map((output, index) => (
                      <option key={`${output.name}-${index}`} value={index}>{output.name}</option>
                    ))}
                  </select>
                )}
                {mapOutputs.length === 0 ? (
                  <div className="empty-output">No map layers.</div>
                ) : (
                  <MapView
                    data={mapData}
                    currentDate={result?.meta?.date_start || date}
                    theme={theme}
                    variableLabel={activeMapOutput?.name || variable}
                    analysisMode="daily"
                    layerStyle={activeMapOutput?.style || null}
                  />
                )}
              </div>
            )}

            {activeOutputTab === 'exports' && (
              <div className="export-output">
                {exportOutputs.length === 0 && <div className="empty-output">No export files.</div>}
                {exportOutputs.map((output, index) => (
                  <a
                    className="export-link"
                    href={apiService.getOperationExportUrl(output.download_url)}
                    key={`${output.filename}-${index}`}
                    download={output.filename}
                  >
                    <span>{output.filename}</span>
                    <strong>{Number(output.size_bytes || 0).toLocaleString()} bytes</strong>
                  </a>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}

export default CustomOperationsWorkspace;
