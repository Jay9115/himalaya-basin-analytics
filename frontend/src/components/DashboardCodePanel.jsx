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

const WORKSPACE_VERSION = 2;

const makeFileId = () => `file-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const cleanFileName = (value, fallback = 'analysis.py') => {
  const trimmed = String(value || '').trim().replace(/[\\/:*?"<>|]+/g, '_');
  return trimmed || fallback;
};

const uniqueFileName = (name, files, excludeId = '') => {
  const clean = cleanFileName(name);
  const used = new Set(files.filter((file) => file.id !== excludeId).map((file) => file.name.toLowerCase()));
  if (!used.has(clean.toLowerCase())) return clean;
  const dotIndex = clean.lastIndexOf('.');
  const stem = dotIndex > 0 ? clean.slice(0, dotIndex) : clean;
  const ext = dotIndex > 0 ? clean.slice(dotIndex) : '';
  let index = 2;
  while (used.has(`${stem}-${index}${ext}`.toLowerCase())) index += 1;
  return `${stem}-${index}${ext}`;
};

const normalizeCodeFile = (file, index, fallbackContent = '') => ({
  id: String(file?.id || makeFileId()),
  name: cleanFileName(file?.name, index === 0 ? 'analysis.py' : `analysis-${index + 1}.py`),
  content: String(file?.content ?? fallbackContent ?? ''),
  validation: file?.validation || null,
  result: file?.result || null,
  activeTab: file?.activeTab || 'terminal',
  activeMapOutputIndex: Number(file?.activeMapOutputIndex) || 0,
  createdAt: file?.createdAt || new Date().toISOString(),
  updatedAt: file?.updatedAt || file?.createdAt || new Date().toISOString(),
});

const normalizeWorkspaceState = (state) => {
  const savedFiles = Array.isArray(state?.files) ? state.files : [];
  if (savedFiles.length > 0) {
    const files = savedFiles.map((file, index) => normalizeCodeFile(file, index));
    const activeFileId = files.some((file) => file.id === state?.activeFileId)
      ? state.activeFileId
      : files[0].id;
    if (state?.code) {
      const activeIndex = files.findIndex((file) => file.id === activeFileId);
      if (activeIndex >= 0) files[activeIndex] = { ...files[activeIndex], content: String(state.code) };
    }
    return { files, activeFileId };
  }

  const file = normalizeCodeFile(
    {
      name: 'analysis.py',
      content: state?.code || DEFAULT_CODE,
      validation: state?.validation || null,
      result: state?.result || null,
      activeTab: state?.activeTab || 'terminal',
      activeMapOutputIndex: Number(state?.activeMapOutputIndex) || 0,
    },
    0
  );
  return { files: [file], activeFileId: file.id };
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
  initialWorkspaceState = null,
  onWorkspaceStateChange = null,
  workspaceStateRef = null,
  outputPortalTargetId = null,
  panelWidth = null,
}) {
  const initialCodeWorkspace = useMemo(() => normalizeWorkspaceState(initialWorkspaceState), [initialWorkspaceState]);
  const [files, setFiles] = useState(() => initialCodeWorkspace.files);
  const [activeFileId, setActiveFileId] = useState(() => initialCodeWorkspace.activeFileId);
  const [panelMode, setPanelMode] = useState(() => initialWorkspaceState?.panelMode || 'code');
  const [chatMessages, setChatMessages] = useState(() => initialWorkspaceState?.chatMessages || []);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState('');
  const [llmHealth, setLlmHealth] = useState(null);
  const chatAbortRef = useRef(null);
  const chatScrollRef = useRef(null);
  const [dateMode, setDateMode] = useState(() => initialWorkspaceState?.dateMode || 'single');
  const [rangeStartDate, setRangeStartDate] = useState(() => initialWorkspaceState?.rangeStartDate || currentDate || dates?.[0] || '');
  const [rangeEndDate, setRangeEndDate] = useState(() => initialWorkspaceState?.rangeEndDate || currentDate || dates?.[0] || '');
  const [timeoutSeconds, setTimeoutSeconds] = useState(() => initialWorkspaceState?.timeoutSeconds || 15);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [activeJobId, setActiveJobId] = useState('');
  const operationAbortRef = useRef(null);
  const [outputPortalTarget, setOutputPortalTarget] = useState(null);
  const latestWorkspaceStateRef = useRef(null);
  const workspaceStateCallbackRef = useRef(onWorkspaceStateChange);

  useEffect(() => {
    workspaceStateCallbackRef.current = onWorkspaceStateChange;
  }, [onWorkspaceStateChange]);

  const activeFile = useMemo(
    () => files.find((file) => file.id === activeFileId) || files[0],
    [activeFileId, files]
  );
  const code = activeFile?.content || '';
  const validation = activeFile?.validation || null;
  const result = activeFile?.result || null;
  const activeTab = activeFile?.activeTab || 'terminal';
  const activeMapOutputIndex = Number(activeFile?.activeMapOutputIndex) || 0;

  const updateFile = useCallback((fileId, updater) => {
    setFiles((current) => current.map((file) => {
      if (file.id !== fileId) return file;
      const patch = typeof updater === 'function' ? updater(file) : updater;
      return { ...file, ...patch, updatedAt: new Date().toISOString() };
    }));
  }, []);

  const updateActiveFile = useCallback((updater) => {
    if (!activeFileId) return;
    updateFile(activeFileId, updater);
  }, [activeFileId, updateFile]);

  const setFileContent = useCallback((fileId, content) => {
    updateFile(fileId, { content: String(content || '') });
  }, [updateFile]);

  const createFile = useCallback(() => {
    const name = window.prompt('New code file name', `analysis-${files.length + 1}.py`);
    if (name === null) return;
    const file = normalizeCodeFile({
      id: makeFileId(),
      name: uniqueFileName(name, files),
      content: '',
    }, files.length);
    setFiles((current) => [...current, file]);
    setActiveFileId(file.id);
  }, [files]);

  const renameActiveFile = useCallback(() => {
    if (!activeFile) return;
    const name = window.prompt('Rename code file', activeFile.name);
    if (name === null) return;
    updateActiveFile({ name: uniqueFileName(name, files, activeFile.id) });
  }, [activeFile, files, updateActiveFile]);

  const removeActiveFile = useCallback(() => {
    if (!activeFile || files.length <= 1) return;
    if (!window.confirm(`Remove ${activeFile.name} from this code workspace?`)) return;
    setFiles((current) => {
      const nextFiles = current.filter((file) => file.id !== activeFile.id);
      setActiveFileId(nextFiles[0]?.id || '');
      return nextFiles;
    });
  }, [activeFile, files.length]);

  useEffect(() => {
    const nextWorkspaceState = {
      workspaceVersion: WORKSPACE_VERSION,
      code,
      files,
      activeFileId: activeFile?.id || activeFileId,
      panelMode,
      chatMessages: chatMessages.slice(-40),
      dateMode,
      rangeStartDate,
      rangeEndDate,
      timeoutSeconds: Number(timeoutSeconds),
      activeTab,
      activeMapOutputIndex,
      validation,
      result,
    };
    latestWorkspaceStateRef.current = nextWorkspaceState;
    if (workspaceStateRef) workspaceStateRef.current = nextWorkspaceState;
    const timer = window.setTimeout(() => {
      workspaceStateCallbackRef.current?.(nextWorkspaceState);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [activeFile?.id, activeFileId, activeMapOutputIndex, activeTab, chatMessages, code, dateMode, files, panelMode, rangeEndDate, rangeStartDate, result, timeoutSeconds, validation, workspaceStateRef]);

  useEffect(() => () => {
    if (latestWorkspaceStateRef.current) {
      workspaceStateCallbackRef.current?.(latestWorkspaceStateRef.current);
    }
  }, []);

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
    updateActiveFile({ content: nextCode });
    setPanelMode('code');
  }, [updateActiveFile]);

  const clearChat = useCallback(() => {
    chatAbortRef.current?.abort?.();
    setChatLoading(false);
    setChatMessages([]);
    setChatError('');
  }, []);

  const validateCode = useCallback(async () => {
    const fileId = activeFile?.id;
    const source = activeFile?.content || '';
    if (!fileId) return { ok: false, errors: [] };
    updateFile(fileId, { validation: null });
    setError('');
    try {
      const response = await apiService.validateOperationCode(source);
      if (!response.ok) {
        updateFile(fileId, {
          validation: response,
          result: buildTerminalFailure({
            status: 'validation_error',
            command: 'POST /operations/validate',
            error: 'Code validation failed.',
            response,
          }),
          activeTab: 'terminal',
        });
      } else {
        updateFile(fileId, {
          validation: response,
          result: {
            ok: true,
            status: 'validation_passed',
            outputs: [],
            stdout: 'Validation passed. Ready to run.',
            stderr: '',
            error: '',
            meta: {},
          },
          activeTab: 'terminal',
        });
      }
      return response;
    } catch (err) {
      const failure = buildTerminalFailure({
        status: err?.response?.status ? `http_${err.response.status}` : 'request_error',
        command: 'POST /operations/validate',
        error: err?.message || 'Validation request failed.',
        response: err?.response?.data,
      });
      updateFile(fileId, {
        result: failure,
        activeTab: 'terminal',
      });
      setError('Validation request failed. See terminal.');
      return { ok: false, errors: [] };
    }
  }, [activeFile, updateFile]);

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

  const waitForOperationJob = useCallback(async (jobId, signal, fileId) => {
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
      updateFile(fileId, { result: payload });
      if (terminalStatuses.has(payload.status)) {
        setActiveJobId('');
        return payload;
      }
    }
    return null;
  }, [updateFile]);

  const runOperation = useCallback(async () => {
    const fileId = activeFile?.id;
    const source = activeFile?.content || '';
    if (!fileId) return;
    if (!datasetId || !selectedVariable || !currentDate) {
      setError('Dashboard data context is not ready yet.');
      return;
    }

    const controller = new AbortController();
    operationAbortRef.current?.abort?.();
    operationAbortRef.current = controller;
    setRunning(true);
    setError('');
    updateFile(fileId, { result: null });
    onMapOutputChange(null);

    try {
      const check = await apiService.validateOperationCode(source, controller.signal);
      if (!check.ok) {
        updateFile(fileId, {
          validation: check,
          result: buildTerminalFailure({
            status: 'validation_error',
            command: 'POST /operations/validate',
            error: 'Code validation failed before execution.',
            response: check,
          }),
          activeTab: 'terminal',
        });
        setError('Code validation failed. See terminal.');
        return;
      }
      updateFile(fileId, { validation: check });

      const selection = buildSelection();
      const plan = await apiService.planOperation(selection, controller.signal);
      if (!plan.can_run_inline) {
        const job = await apiService.submitOperationJob(
          {
            code: source,
            selection,
            timeout_seconds: Math.max(600, Number(timeoutSeconds) * 60),
          },
          controller.signal
        );
        setActiveJobId(job.job_id || '');
        updateFile(fileId, { result: job, activeTab: 'terminal' });
        const finalJob = await waitForOperationJob(job.job_id, controller.signal, fileId);
        if (finalJob) updateFile(fileId, { result: finalJob });
      } else {
        const payload = await apiService.runOperation(
          {
            code: source,
            selection,
            timeout_seconds: Number(timeoutSeconds),
          },
          controller.signal
        );
        updateFile(fileId, { result: payload });
      }
      updateFile(fileId, { activeMapOutputIndex: 0, activeTab: 'terminal' });
    } catch (err) {
      const canceled = err?.name === 'CanceledError' || err?.name === 'AbortError' || err?.code === 'ERR_CANCELED';
      if (!canceled) {
        updateFile(fileId, {
          result: buildTerminalFailure({
            status: err?.response?.status ? `http_${err.response.status}` : 'request_error',
            command: 'POST /operations/run',
            error: err?.message || 'Operation failed.',
            response: err?.response?.data,
          }),
          activeTab: 'terminal',
        });
        setError('Operation failed. See terminal.');
      }
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }, [activeFile, buildSelection, currentDate, datasetId, onMapOutputChange, selectedVariable, timeoutSeconds, updateFile, waitForOperationJob]);

  const cancelOperation = useCallback(() => {
    operationAbortRef.current?.abort?.();
    if (activeJobId) {
      apiService.cancelOperationJob(activeJobId)
        .then((payload) => updateActiveFile({ result: payload }))
        .catch(() => { });
      setActiveJobId('');
    }
    setRunning(false);
  }, [activeJobId, updateActiveFile]);

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
          <div className="dashboard-code-workspace">
            <aside className="dashboard-code-explorer" aria-label="Code files">
              <div className="dashboard-code-file-list">
                <div className="dashboard-code-file-list-header">
                  <button type="button" className="icon-btn-add" onClick={createFile} title="New file">+</button>
                </div>
                {files.map((file) => (
                  <div
                    key={file.id}
                    className={`dashboard-code-file-item ${file.id === activeFile?.id ? 'active' : ''}`}
                    onClick={() => setActiveFileId(file.id)}
                    title={file.name}
                  >
                    <div className="dashboard-code-file-info">
                      <svg viewBox="0 0 24 24" aria-hidden="true" width="14" height="14" fill="currentColor">
                        <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z" />
                      </svg>
                      <span>{file.name}</span>
                      {file.result && (
                        <span className={`status-dot ${file.result.ok ? 'ok' : 'error'}`} title={file.result.status || (file.result.ok ? 'ok' : 'error')} />
                      )}
                    </div>
                    {file.id === activeFile?.id && (
                      <div className="dashboard-code-file-actions-inline">
                        <button type="button" onClick={(e) => { e.stopPropagation(); renameActiveFile(); }} title="Rename">✎</button>
                        <button type="button" onClick={(e) => { e.stopPropagation(); removeActiveFile(); }} disabled={files.length <= 1} title="Remove">🗑</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </aside>

            <div className="dashboard-code-workbench">
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
                  <button type="button" className="dashboard-code-secondary icon-btn" onClick={validateCode} disabled={running} title="Validate">✓</button>
                  {running ? (
                    <button type="button" className="dashboard-code-danger" onClick={cancelOperation} title="Stop">■</button>
                  ) : (
                    <button type="button" className="dashboard-code-primary" onClick={runOperation} title="Run">▶</button>
                  )}
                </div>
              </div>

              <div className="dashboard-code-editor">
                <Editor
                  height="100%"
                  defaultLanguage="python"
                  theme={theme === 'dark' ? 'vs-dark' : 'vs'}
                  value={code}
                  path={activeFile?.id || 'analysis.py'}
                  onChange={(value) => setFileContent(activeFile?.id, value || '')}
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
                {activeFile && <span>{activeFile.name}</span>}
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
                    <select value={activeMapOutputIndex} onChange={(event) => updateActiveFile({ activeMapOutputIndex: Number(event.target.value) })}>
                      {mapOutputs.map((output, index) => (
                        <option key={`${output.name}-${index}`} value={index}>{output.name || `Layer ${index + 1}`}</option>
                      ))}
                    </select>
                  </label>
                )}
                {error && <span className="status-error">{error}</span>}
              </div>
            </div>
          </div>

          <div className="dashboard-code-tabs">
            {['terminal', 'table', 'chart', 'exports'].map((tab) => (
              <button
                key={tab}
                type="button"
                className={activeTab === tab ? 'active' : ''}
                onClick={() => updateActiveFile({ activeTab: tab })}
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
