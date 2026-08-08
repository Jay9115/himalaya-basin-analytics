import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import Editor, { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import apiService from '../services/api';
import llmService from '../services/llmService';
import OperationChartRenderer from './OperationChartRenderer';
import './DashboardCodePanel.css';

loader.config({ monaco });

const DEFAULT_CODE = `def run(hb, df, meta):
    if meta.get("large_mode"):
        annual = hb.aggregate(by=["year"], metrics={"value": "mean"})
        hb.text(f"{meta['dataset_label']} large analysis rows: {meta['row_count']}")
        hb.table(annual, name="annual_mean")
        hb.chart(annual, chart_type="line", x="year", y="value_mean", name="annual_mean_chart")
        hb.export_csv(annual, filename="annual_mean.csv")
        return

    hb.text(f"{meta['dataset_label']} | rows: {len(df)}")
    hb.number("mean_value", df["value"].mean())

    daily = df.groupby("date", as_index=False)["value"].mean()
    hb.table(daily, name="daily_mean")
    hb.chart(daily, chart_type="line", x="date", y="value", name="daily_mean_chart")

    hb.map_points(
        df,
        name="code_result_layer",
        style={"palette": "viridis", "radius": 4, "opacity": 0.78},
    )
    hb.export_csv(daily, filename="daily_mean.csv")
`;

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

const normalizeMapOutput = (output) => {
  if (!output) return [];
  if (output.layer_type === 'geojson') {
    return output.feature_collection?.features || [];
  }
  return output.features || [];
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

const tableValue = (columns, row, key) => {
  const index = columns.indexOf(key);
  return index >= 0 ? row[index] : undefined;
};

const extractCodeFromAssistant = (text) => {
  if (!text) return '';
  const fenced = text.match(/```(?:python)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  return text.trim();
};

const buildChatContextPrefix = ({
  datasetLabel,
  datasetId,
  selectedVariable,
  currentDate,
  selectedElevRange,
  selectedSubregionLabel,
  yearRange,
}) => {
  const pieces = [
    `dataset=${datasetLabel || datasetId || 'unknown'}`,
    `variable=${selectedVariable || 'unknown'}`,
    `date=${currentDate || 'unknown'}`,
    `elevation=${selectedElevRange?.min ?? '?'} to ${selectedElevRange?.max ?? '?'}`,
  ];
  if (yearRange?.start && yearRange?.end) {
    pieces.push(`years=${yearRange.start}-${yearRange.end}`);
  }
  if (selectedSubregionLabel) {
    pieces.push(`subregion=${selectedSubregionLabel}`);
  }
  return `[Dashboard context: ${pieces.join(', ')}]`;
};

function DashboardCodePanel({
  theme,
  datasetId,
  datasetLabel,
  yearRange,
  currentDate,
  dates,
  selectedVariable,
  selectedElevRange,
  selectedSubregionId,
  selectedSubregionLabel,
  onClose,
  onMapOutputChange,
  outputPortalTargetId = null,
  panelWidth = null,
}) {
  const [code, setCode] = useState(DEFAULT_CODE);
  const [panelMode, setPanelMode] = useState('code');
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState('');
  const [llmHealth, setLlmHealth] = useState(null);
  const chatAbortRef = useRef(null);
  const chatScrollRef = useRef(null);
  const [dateMode, setDateMode] = useState('single');
  const [rangeStartDate, setRangeStartDate] = useState(currentDate || dates?.[0] || '');
  const [rangeEndDate, setRangeEndDate] = useState(currentDate || dates?.[0] || '');
  const [timeoutSeconds, setTimeoutSeconds] = useState(15);
  const [validation, setValidation] = useState(null);
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState('terminal');
  const [activeMapOutputIndex, setActiveMapOutputIndex] = useState(0);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [activeJobId, setActiveJobId] = useState('');
  const operationAbortRef = useRef(null);
  const [outputPortalTarget, setOutputPortalTarget] = useState(null);

  const mapOutputs = useMemo(
    () => (result?.outputs || []).filter((output) => output.type === 'map_layer'),
    [result]
  );
  const activeMapOutput = mapOutputs[Math.min(activeMapOutputIndex, Math.max(0, mapOutputs.length - 1))];
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

  useLayoutEffect(() => {
    if (!outputPortalTargetId || typeof document === 'undefined') {
      setOutputPortalTarget(null);
      return;
    }
    setOutputPortalTarget(document.getElementById(outputPortalTargetId));
  }, [outputPortalTargetId]);

  useEffect(() => {
    if (!currentDate) return;
    setRangeStartDate((prev) => prev || currentDate);
    setRangeEndDate((prev) => prev || currentDate);
  }, [currentDate]);

  useEffect(() => {
    if (!activeMapOutput) {
      onMapOutputChange(null);
      return;
    }
    onMapOutputChange({
      data: normalizeMapOutput(activeMapOutput),
      style: activeMapOutput.style || null,
      label: activeMapOutput.name || 'Code Result',
      output: activeMapOutput,
      meta: result?.meta || {},
    });
  }, [activeMapOutput, onMapOutputChange, result]);

  useEffect(() => () => {
    operationAbortRef.current?.abort?.();
    chatAbortRef.current?.abort?.();
    onMapOutputChange(null);
  }, [onMapOutputChange]);

  useEffect(() => {
    if (panelMode !== 'chatbot') return undefined;

    const controller = new AbortController();
    llmService.getHealth(controller.signal)
      .then((payload) => {
        setLlmHealth(payload);
        setChatError('');
      })
      .catch((err) => {
        if (err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return;
        setLlmHealth(null);
        setChatError('LLM service unavailable at http://127.0.0.1:8010. Start START_LLM.bat first.');
      });

    return () => controller.abort();
  }, [panelMode]);

  useEffect(() => {
    if (!chatScrollRef.current) return;
    chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
  }, [chatMessages, chatLoading, panelMode]);

  const sendChatMessage = useCallback(async () => {
    const trimmed = chatInput.trim();
    if (!trimmed || chatLoading) return;

    const controller = new AbortController();
    chatAbortRef.current?.abort?.();
    chatAbortRef.current = controller;

    const contextPrefix = buildChatContextPrefix({
      datasetLabel,
      datasetId,
      selectedVariable,
      currentDate,
      selectedElevRange,
      selectedSubregionLabel,
      yearRange,
    });
    const requestMessage = `${contextPrefix}\n\n${trimmed}`;

    setChatLoading(true);
    setChatError('');
    setChatMessages((prev) => [...prev, { role: 'user', content: trimmed }]);
    setChatInput('');

    try {
      const response = await llmService.chat(requestMessage, { signal: controller.signal });
      const assistantText = llmService.extractMessage(response) || 'No response returned.';
      setChatMessages((prev) => [...prev, { role: 'assistant', content: assistantText }]);
    } catch (err) {
      if (err?.name === 'CanceledError' || err?.name === 'AbortError' || err?.code === 'ERR_CANCELED') {
        return;
      }
      const detail = err?.response?.data?.detail || err?.message || 'Chat request failed.';
      setChatError(String(detail));
      setChatMessages((prev) => [...prev, { role: 'assistant', content: `Error: ${detail}`, error: true }]);
    } finally {
      if (!controller.signal.aborted) setChatLoading(false);
    }
  }, [
    chatInput,
    chatLoading,
    currentDate,
    datasetId,
    datasetLabel,
    selectedElevRange,
    selectedSubregionLabel,
    selectedVariable,
    yearRange,
  ]);

  const insertAssistantCode = useCallback((content) => {
    const nextCode = extractCodeFromAssistant(content);
    if (!nextCode) return;
    setCode(nextCode);
    setPanelMode('code');
  }, []);

  const clearChat = useCallback(() => {
    chatAbortRef.current?.abort?.();
    setChatLoading(false);
    setChatMessages([]);
    setChatError('');
  }, []);

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
      }
      setActiveTab('terminal');
      return response;
    } catch (err) {
      const failure = buildTerminalFailure({
        status: err?.response?.status ? `http_${err.response.status}` : 'request_error',
        command: 'POST /operations/validate',
        error: err?.message || 'Validation request failed.',
        response: err?.response?.data,
      });
      setResult(failure);
      setActiveTab('terminal');
      setError('Validation request failed. See terminal.');
      return { ok: false, errors: [] };
    }
  }, [code]);

  const buildSelection = useCallback(() => {
    const selection = {
      dataset: datasetId,
      variable: selectedVariable,
      elev_min: Number(selectedElevRange.min),
      elev_max: Number(selectedElevRange.max),
      year_start: yearRange?.start,
      year_end: yearRange?.end,
    };
    if (selectedSubregionId) selection.subregion_id = selectedSubregionId;
    if (dateMode === 'single') {
      selection.date = currentDate;
    } else {
      const first = rangeStartDate <= rangeEndDate ? rangeStartDate : rangeEndDate;
      const last = rangeStartDate <= rangeEndDate ? rangeEndDate : rangeStartDate;
      selection.start_date = first;
      selection.end_date = last;
    }
    return selection;
  }, [
    currentDate,
    datasetId,
    dateMode,
    rangeEndDate,
    rangeStartDate,
    selectedElevRange,
    selectedSubregionId,
    selectedVariable,
    yearRange,
  ]);

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
    if (!datasetId || !selectedVariable || !currentDate) {
      setError('Dashboard data context is not ready yet.');
      return;
    }

    const controller = new AbortController();
    operationAbortRef.current?.abort?.();
    operationAbortRef.current = controller;
    setRunning(true);
    setError('');
    setResult(null);
    onMapOutputChange(null);

    try {
      const check = await apiService.validateOperationCode(code, controller.signal);
      setValidation(check);
      if (!check.ok) {
        setResult(buildTerminalFailure({
          status: 'validation_error',
          command: 'POST /operations/validate',
          error: 'Code validation failed before execution.',
          response: check,
        }));
        setActiveTab('terminal');
        setError('Code validation failed. See terminal.');
        return;
      }

      const selection = buildSelection();
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
        const finalJob = await waitForOperationJob(job.job_id, controller.signal);
        if (finalJob) setResult(finalJob);
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
      }
      setActiveMapOutputIndex(0);
      setActiveTab('terminal');
    } catch (err) {
      const canceled = err?.name === 'CanceledError' || err?.name === 'AbortError' || err?.code === 'ERR_CANCELED';
      if (!canceled) {
        setResult(buildTerminalFailure({
          status: err?.response?.status ? `http_${err.response.status}` : 'request_error',
          command: 'POST /operations/run',
          error: err?.message || 'Operation failed.',
          response: err?.response?.data,
        }));
        setActiveTab('terminal');
        setError('Operation failed. See terminal.');
      }
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }, [buildSelection, code, currentDate, datasetId, onMapOutputChange, selectedVariable, timeoutSeconds, waitForOperationJob]);

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

  const outputSection = (
    <div className="dashboard-code-output dashboard-code-output-docked">
      {activeTab === 'terminal' && (
        <div className="dashboard-terminal">
          <pre>{terminalText || 'No terminal output yet.'}</pre>
          {numberOutputs.length > 0 && (
            <div className="dashboard-number-grid">
              {numberOutputs.map((output, index) => (
                <div key={`${output.name}-${index}`} className="dashboard-number-tile">
                  <span>{output.name}</span>
                  <strong>{typeof output.value === 'number' ? output.value.toFixed(4) : JSON.stringify(output.value)}</strong>
                  {output.units && <small>{output.units}</small>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'table' && (
        <div className="dashboard-table-output">
          {tableOutputs.length === 0 && <div className="dashboard-empty-output">No tables.</div>}
          {tableOutputs.map((output, outputIndex) => (
            <div className="dashboard-table-block" key={`${output.name}-${outputIndex}`}>
              <div className="dashboard-output-title">{output.name} | {Number(output.row_count || 0).toLocaleString()} rows</div>
              <div className="dashboard-table-scroll">
                <table>
                  <thead>
                    <tr>
                      {(output.columns || []).map((column) => <th key={column}>{column}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {(output.rows || []).slice(0, 100).map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {(output.columns || []).map((column) => (
                          <td key={column}>{String(tableValue(output.columns, row, column) ?? '')}</td>
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

      {activeTab === 'chart' && (
        <div className="dashboard-chart-output">
          {chartOutputs.length === 0 && <div className="dashboard-empty-output">No charts.</div>}
          {chartOutputs.map((output, index) => {
            return (
              <div className="dashboard-chart-block" key={`${output.name}-${index}`}>
                <div className="dashboard-output-title">{output.name} | {output.chart_type || 'line'}</div>
                <OperationChartRenderer output={output.points ? output : { ...output, points: tableRowsToObjects(output) }} height={210} compact />
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'exports' && (
        <div className="dashboard-export-output">
          {exportOutputs.length === 0 && <div className="dashboard-empty-output">No export files.</div>}
          {exportOutputs.map((output, index) => (
            <a
              className="dashboard-export-link"
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
  );

  return (
    <aside
      className="dashboard-code-panel"
      data-theme={theme}
      style={Number.isFinite(panelWidth) ? { flex: `0 0 ${panelWidth}px`, width: `${panelWidth}px`, maxWidth: 'none' } : undefined}
    >
      <div className="dashboard-code-note">
        <div>
          <strong>{panelMode === 'code' ? 'HB Code' : 'HB Chatbot'}</strong>
          <span>{datasetLabel || datasetId} | {selectedVariable || 'variable'} | {currentDate || 'date'}</span>
          {selectedSubregionLabel && <span>{selectedSubregionLabel}</span>}
        </div>
        <div className="dashboard-code-note-actions">
          <div className="dashboard-code-mode-switch">
            <button
              type="button"
              className={panelMode === 'code' ? 'active' : ''}
              onClick={() => setPanelMode('code')}
            >
              Code
            </button>
            <button
              type="button"
              className={panelMode === 'chatbot' ? 'active' : ''}
              onClick={() => setPanelMode('chatbot')}
            >
              Chatbot
            </button>
          </div>
          <button type="button" className="dashboard-code-close" onClick={onClose}>Close</button>
        </div>
      </div>

      {panelMode === 'code' && (
      <>
      <div className="dashboard-code-toolbar">
        <div className="dashboard-code-date-mode">
          <button
            type="button"
            className={dateMode === 'single' ? 'active' : ''}
            onClick={() => setDateMode('single')}
          >
            Current Date
          </button>
          <button
            type="button"
            className={dateMode === 'range' ? 'active' : ''}
            onClick={() => setDateMode('range')}
          >
            Date Range
          </button>
        </div>
        {dateMode === 'range' && (
          <div className="dashboard-code-range">
            <select value={rangeStartDate} onChange={(event) => setRangeStartDate(event.target.value)}>
              {(dates || []).map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
            <select value={rangeEndDate} onChange={(event) => setRangeEndDate(event.target.value)}>
              {(dates || []).map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
        )}
        <div className="dashboard-code-limits">
          <label>
            Sec
            <input type="number" min="1" max="60" value={timeoutSeconds} onChange={(event) => setTimeoutSeconds(event.target.value)} />
          </label>
        </div>
        <div className="dashboard-code-actions">
          <button type="button" className="dashboard-code-secondary" onClick={validateCode} disabled={running}>Validate</button>
          {running ? (
            <button type="button" className="dashboard-code-danger" onClick={cancelOperation}>Stop</button>
          ) : (
            <button type="button" className="dashboard-code-primary" onClick={runOperation}>Run</button>
          )}
        </div>
      </div>

      <div className="dashboard-code-editor">
        <Editor
          height="100%"
          defaultLanguage="python"
          theme={theme === 'dark' ? 'vs-dark' : 'vs'}
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

      <div className="dashboard-code-status">
        {validation && (
          <span className={validation.ok ? 'status-ok' : 'status-error'}>
            {validation.ok ? 'Validation passed' : `${validation.errors?.length || 0} validation errors`}
          </span>
        )}
        {result && (
          <span className={result.ok ? 'status-ok' : 'status-error'}>
            {result.status} | {Number(result.duration_ms || 0).toLocaleString()} ms | {Number(result.meta?.row_count || 0).toLocaleString()} rows
          </span>
        )}
        {mapOutputs.length > 0 && (
          <label>
            Map
            <select value={activeMapOutputIndex} onChange={(event) => setActiveMapOutputIndex(Number(event.target.value))}>
              {mapOutputs.map((output, index) => (
                <option key={`${output.name}-${index}`} value={index}>{output.name || `Layer ${index + 1}`}</option>
              ))}
            </select>
          </label>
        )}
        {error && <span className="status-error">{error}</span>}
      </div>

      <div className="dashboard-code-tabs">
        {['terminal', 'table', 'chart', 'exports'].map((tab) => (
          <button
            key={tab}
            type="button"
            className={activeTab === tab ? 'active' : ''}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      {!outputPortalTarget && outputSection}
      {outputPortalTarget && createPortal(outputSection, outputPortalTarget)}
      </>
      )}

      {panelMode === 'chatbot' && (
        <>
          <div className="dashboard-chat-toolbar">
            <span className={`dashboard-chat-health ${llmHealth?.status === 'ok' ? 'online' : 'offline'}`}>
              {llmHealth?.loaded
                ? 'LLM ready'
                : llmHealth?.error
                  ? 'LLM model not loaded'
                  : llmHealth?.status === 'ok'
                    ? 'LLM online'
                    : 'LLM offline'}
            </span>
            <button type="button" className="dashboard-code-secondary" onClick={clearChat} disabled={chatLoading}>
              Clear
            </button>
          </div>

          <div className="dashboard-chat-panel" ref={chatScrollRef}>
            {chatMessages.length === 0 && (
              <div className="dashboard-chat-empty">
                Ask about HB analytics, request Python using hb/df/meta, or get help with the current dashboard selection.
              </div>
            )}
            {chatMessages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={`dashboard-chat-message ${message.role}${message.error ? ' error' : ''}`}
              >
                <div className="dashboard-chat-message-role">{message.role === 'user' ? 'You' : 'Assistant'}</div>
                <pre>{message.content}</pre>
                {message.role === 'assistant' && !message.error && (
                  <button
                    type="button"
                    className="dashboard-chat-insert"
                    onClick={() => insertAssistantCode(message.content)}
                  >
                    Use as code
                  </button>
                )}
              </div>
            ))}
            {chatLoading && (
              <div className="dashboard-chat-message assistant loading">
                <div className="dashboard-chat-message-role">Assistant</div>
                <pre>Thinking...</pre>
              </div>
            )}
          </div>

          <div className="dashboard-chat-compose">
            <textarea
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="Ask the Himalaya Basin assistant..."
              rows={3}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  sendChatMessage();
                }
              }}
              disabled={chatLoading}
            />
            <button
              type="button"
              className="dashboard-code-primary"
              onClick={sendChatMessage}
              disabled={chatLoading || !chatInput.trim()}
            >
              {chatLoading ? 'Sending...' : 'Send'}
            </button>
          </div>

          <div className="dashboard-code-status">
            {chatError && <span className="status-error">{chatError}</span>}
            {!chatError && llmHealth && (
              <span className={llmHealth.loaded ? 'status-ok' : 'status-error'}>
                {llmHealth.loaded ? 'Model loaded' : 'Waiting for model in Models folder'}
              </span>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

export default DashboardCodePanel;
