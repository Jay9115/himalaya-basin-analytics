import React, { useMemo, useState, useCallback, useEffect } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import './TempGraph.css';

const SERIES_COLORS = [
  '#0072b2',
  '#d55e00',
  '#009e73',
  '#cc79a7',
  '#e69f00',
  '#56b4e9',
  '#000000',
  '#7f7f7f',
];

const toFiniteNumber = (value) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : null;
};

const getDefaultValue = (point) => (
  point?.mean_value ?? point?.mean_temp ?? point?.value
);

const getDefaultPixels = (point) => (
  point?.pixel_count ?? point?.count ?? point?.pixels
);

function TempGraph({ data, currentDate, variableLabel, series = [], showPointStats, pointStatsLabel }) {
  const dangerColor = 'var(--danger)';
  const label = variableLabel || 'Value';
  const pointsLabel = pointStatsLabel || 'Data points/day';
  const [cutMode, setCutMode] = useState(false);
  const [cutStart, setCutStart] = useState(null);
  const [cutEnd, setCutEnd] = useState(null);
  const [indexedMode, setIndexedMode] = useState(false);

  const chartSeries = useMemo(() => {
    if (Array.isArray(series) && series.length > 0) {
      return series.map((item, index) => ({
        key: item.key || `series_${index + 1}`,
        label: item.label || item.key || `Series ${index + 1}`,
        color: item.color || SERIES_COLORS[index % SERIES_COLORS.length],
      }));
    }
    return [{ key: 'value', label, color: SERIES_COLORS[0] }];
  }, [series, label]);

  const hasMultipleSeries = chartSeries.length > 1;

  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];

    const mapped = data.map((point) => {
      const next = {
        date: point.date,
        pixels: getDefaultPixels(point),
      };

      chartSeries.forEach((item) => {
        const rawValue = point[item.key] ?? (!hasMultipleSeries ? getDefaultValue(point) : undefined);
        const rawPixels = point[`${item.key}__pixels`] ?? getDefaultPixels(point);
        next[item.key] = toFiniteNumber(rawValue);
        next[`${item.key}__pixels`] = toFiniteNumber(rawPixels);
      });

      return next;
    });

    return mapped
      .filter((point) => point.date)
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [data, chartSeries, hasMultipleSeries]);

  useEffect(() => {
    if (chartData.length === 0) return;
    if (!cutStart && !cutEnd) return;
    const minDate = chartData[0].date;
    const maxDate = chartData[chartData.length - 1].date;

    const clampDate = (value) => {
      if (!value) return value;
      if (value < minDate) return minDate;
      if (value > maxDate) return maxDate;
      return value;
    };

    const nextStart = clampDate(cutStart);
    const nextEnd = clampDate(cutEnd);
    if (nextStart !== cutStart) setCutStart(nextStart);
    if (nextEnd !== cutEnd) setCutEnd(nextEnd);
  }, [chartData, cutStart, cutEnd]);

  useEffect(() => {
    if (!hasMultipleSeries && indexedMode) {
      setIndexedMode(false);
    }
  }, [hasMultipleSeries, indexedMode]);

  const zoomRange = useMemo(() => {
    if (!cutStart || !cutEnd) return null;
    const start = cutStart <= cutEnd ? cutStart : cutEnd;
    const end = cutStart <= cutEnd ? cutEnd : cutStart;
    return { start, end };
  }, [cutStart, cutEnd]);

  const visibleData = useMemo(() => {
    if (!zoomRange) return chartData;
    return chartData.filter((point) => point.date >= zoomRange.start && point.date <= zoomRange.end);
  }, [chartData, zoomRange]);

  const plotData = useMemo(() => {
    if (!indexedMode || !hasMultipleSeries) return visibleData;

    const ranges = new Map();
    chartSeries.forEach((item) => {
      const values = visibleData
        .map((point) => point[item.key])
        .filter((value) => Number.isFinite(value));
      if (values.length === 0) {
        ranges.set(item.key, { min: 0, max: 1 });
        return;
      }
      const min = Math.min(...values);
      const max = Math.max(...values);
      ranges.set(item.key, { min, max: min === max ? min + 1 : max });
    });

    return visibleData.map((point) => {
      const next = { ...point };
      chartSeries.forEach((item) => {
        const value = point[item.key];
        const range = ranges.get(item.key);
        next[item.key] = Number.isFinite(value)
          ? ((value - range.min) / (range.max - range.min)) * 100
          : null;
      });
      return next;
    });
  }, [indexedMode, hasMultipleSeries, visibleData, chartSeries]);

  const stats = useMemo(() => {
    if (!visibleData || visibleData.length === 0) return [];

    return chartSeries.map((item) => {
      const values = visibleData
        .map((point) => point[item.key])
        .filter((value) => Number.isFinite(value));
      if (values.length === 0) return null;

      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const min = Math.min(...values);
      const max = Math.max(...values);
      const pointValues = visibleData
        .map((point) => point[`${item.key}__pixels`] ?? point.pixels)
        .filter((value) => Number.isFinite(value));
      const avgPoints = pointValues.length > 0
        ? pointValues.reduce((a, b) => a + b, 0) / pointValues.length
        : null;

      return { ...item, mean, min, max, avgPoints };
    }).filter(Boolean);
  }, [visibleData, chartSeries]);

  const handleChartClick = useCallback((event) => {
    if (!cutMode) return;
    const activeLabel = event?.activeLabel;
    if (!activeLabel) return;
    if (!cutStart || (cutStart && cutEnd)) {
      setCutStart(activeLabel);
      setCutEnd(null);
      return;
    }
    setCutEnd(activeLabel);
  }, [cutMode, cutStart, cutEnd]);

  const handleCutToggle = useCallback(() => {
    setCutMode((prev) => {
      const next = !prev;
      if (!next) {
        setCutStart(null);
        setCutEnd(null);
      }
      return next;
    });
  }, []);

  const handleClearZoom = useCallback(() => {
    setCutStart(null);
    setCutEnd(null);
  }, []);

  const CustomTooltip = ({ active, payload, label: tooltipDate }) => {
    if (!active || !payload || payload.length === 0) return null;
    const point = payload[0]?.payload || {};

    return (
      <div className="custom-tooltip">
        <p className="tooltip-date">{tooltipDate}</p>
        {payload.map((item) => {
          const seriesItem = chartSeries.find((seriesItem) => seriesItem.key === item.dataKey);
          const rawValue = point[item.dataKey];
          return (
            <p className="tooltip-temp" key={item.dataKey}>
              <span className="tooltip-swatch" style={{ background: item.color }} />
              {seriesItem?.label || item.name}: <strong>{Number.isFinite(rawValue) ? rawValue.toFixed(2) : 'N/A'}</strong>
              {indexedMode && hasMultipleSeries ? ' index' : ''}
            </p>
          );
        })}
        {!hasMultipleSeries && Number.isFinite(point.pixels) && (
          <p className="tooltip-pixels">
            Data points: {point.pixels.toLocaleString()}
          </p>
        )}
      </div>
    );
  };

  if (chartData.length === 0) {
    return (
      <div className="temp-graph">
        <h3>Basin Mean {label}</h3>
        <div className="no-data">
          No data available for the selected elevation range
        </div>
      </div>
    );
  }

  return (
    <div className="temp-graph">
      <div className="graph-header">
        <div className="graph-title-block">
          <h3>{hasMultipleSeries ? 'Basin Mean Variable Comparison' : `Basin Mean ${label} Over Time`}</h3>
          <span className="graph-subtitle">
            {zoomRange ? `${zoomRange.start} to ${zoomRange.end}` : `${visibleData.length} days`}
          </span>
        </div>
        <div className="graph-actions">
          {hasMultipleSeries && (
            <div className="graph-mode-switch" aria-label="Comparison scale">
              <button
                type="button"
                className={!indexedMode ? 'active' : ''}
                onClick={() => setIndexedMode(false)}
              >
                Raw
              </button>
              <button
                type="button"
                className={indexedMode ? 'active' : ''}
                onClick={() => setIndexedMode(true)}
              >
                Indexed
              </button>
            </div>
          )}
          <button
            type="button"
            className={`graph-cut-btn ${cutMode ? 'active' : ''}`}
            onClick={handleCutToggle}
            title="Cut by date range"
          >
            Cut
          </button>
          {zoomRange && (
            <button
              type="button"
              className="graph-clear-btn"
              onClick={handleClearZoom}
            >
              Clear
            </button>
          )}
        </div>
        {stats.length > 0 && (
          <div className={`graph-stats ${hasMultipleSeries ? 'multi' : ''}`}>
            {stats.map((item) => (
              <span className="stat" key={item.key}>
                <span className="stat-swatch" style={{ background: item.color }} />
                <span className="stat-label">{hasMultipleSeries ? item.label : 'Mean'}:</span>
                <span className="stat-value">{item.mean.toFixed(2)}</span>
                {hasMultipleSeries && (
                  <span className="stat-range">
                    {item.min.toFixed(2)} to {item.max.toFixed(2)}
                  </span>
                )}
              </span>
            ))}
            {!hasMultipleSeries && (
              <>
                <span className="stat">
                  <span className="stat-label">Min:</span>
                  <span className="stat-value min">{stats[0].min.toFixed(2)}</span>
                </span>
                <span className="stat">
                  <span className="stat-label">Max:</span>
                  <span className="stat-value max">{stats[0].max.toFixed(2)}</span>
                </span>
                {showPointStats && Number.isFinite(stats[0].avgPoints) && (
                  <span className="stat">
                    <span className="stat-label">{pointsLabel}:</span>
                    <span className="stat-value">{Math.round(stats[0].avgPoints).toLocaleString()}</span>
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>

      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={plotData}
          margin={{ top: 12, right: 28, left: 8, bottom: 36 }}
          onClick={handleChartClick}
        >
          <CartesianGrid strokeDasharray="2 4" stroke="var(--plot-grid)" vertical={false} />
          <XAxis
            dataKey="date"
            stroke="var(--plot-axis)"
            tick={{ fill: 'var(--plot-axis)', fontSize: 11 }}
            tickLine={{ stroke: 'var(--plot-axis)' }}
            axisLine={{ stroke: 'var(--plot-axis)' }}
            angle={-35}
            textAnchor="end"
            height={70}
            interval="preserveStartEnd"
          />
          <YAxis
            stroke="var(--plot-axis)"
            tick={{ fill: 'var(--plot-axis)', fontSize: 12 }}
            tickLine={{ stroke: 'var(--plot-axis)' }}
            axisLine={{ stroke: 'var(--plot-axis)' }}
            label={{
              value: indexedMode && hasMultipleSeries ? 'Indexed value (0-100)' : label,
              angle: -90,
              position: 'insideLeft',
              style: { fill: 'var(--plot-axis)', fontSize: 12 },
            }}
          />
          <Tooltip content={<CustomTooltip />} />
          {hasMultipleSeries && (
            <Legend
              verticalAlign="top"
              height={28}
              iconType="plainline"
              wrapperStyle={{ color: 'var(--text)', fontSize: 12 }}
            />
          )}

          {currentDate && (
            <ReferenceLine
              x={currentDate}
              stroke={dangerColor}
              strokeWidth={1.6}
              strokeDasharray="4 4"
              label={{
                value: 'Current',
                position: 'top',
                fill: dangerColor,
                fontSize: 11,
              }}
            />
          )}

          {chartSeries.map((item) => (
            <Line
              key={item.key}
              type="monotone"
              dataKey={item.key}
              name={item.label}
              stroke={item.color}
              strokeWidth={hasMultipleSeries ? 2.2 : 2.4}
              dot={false}
              connectNulls
              activeDot={{ r: 4.5, fill: item.color, stroke: 'var(--plot-surface)', strokeWidth: 1.5 }}
              animationDuration={240}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default React.memo(TempGraph);
