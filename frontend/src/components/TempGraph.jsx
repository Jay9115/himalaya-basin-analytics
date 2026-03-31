import React, { useMemo, useState, useCallback, useEffect } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import './TempGraph.css';

function TempGraph({ data, currentDate, variableLabel, showPointStats, pointStatsLabel }) {
  const dangerColor = 'var(--danger)';
  const label = variableLabel || 'Value';
  const pointsLabel = pointStatsLabel || 'Data points/day';
  const [cutMode, setCutMode] = useState(false);
  const [cutStart, setCutStart] = useState(null);
  const [cutEnd, setCutEnd] = useState(null);

  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    
    const mapped = data.map((d) => ({
      date: d.date,
      value: d.mean_value ?? d.mean_temp ?? d.value,
      pixels: d.pixel_count ?? d.count,
    }));
    return mapped.sort((a, b) => a.date.localeCompare(b.date));
  }, [data]);

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

  const zoomRange = useMemo(() => {
    if (!cutStart || !cutEnd) return null;
    const start = cutStart <= cutEnd ? cutStart : cutEnd;
    const end = cutStart <= cutEnd ? cutEnd : cutStart;
    return { start, end };
  }, [cutStart, cutEnd]);

  const visibleData = useMemo(() => {
    if (!zoomRange) return chartData;
    return chartData.filter((d) => d.date >= zoomRange.start && d.date <= zoomRange.end);
  }, [chartData, zoomRange]);

  const CustomTooltip = ({ active, payload }) => {
    if (active && payload && payload.length) {
      const point = payload[0].payload;
      return (
        <div className="custom-tooltip">
          <p className="tooltip-date">{point.date}</p>
          <p className="tooltip-temp">
            {label}: <strong>{Number.isFinite(point.value) ? point.value.toFixed(2) : 'N/A'}</strong>
          </p>
          <p className="tooltip-pixels">
            Data points: {point.pixels.toLocaleString()}
          </p>
        </div>
      );
    }
    return null;
  };

  const stats = useMemo(() => {
    if (!visibleData || visibleData.length === 0) return null;
    
    const values = visibleData.map(d => d.value).filter((v) => Number.isFinite(v));
    if (values.length === 0) return null;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const min = Math.min(...values);
    const max = Math.max(...values);
    
    let avgPoints = null;
    const pointValues = visibleData.map(d => d.pixels).filter((v) => Number.isFinite(v));
    if (pointValues.length > 0) {
      avgPoints = pointValues.reduce((a, b) => a + b, 0) / pointValues.length;
    }

    return { mean, min, max, avgPoints };
  }, [visibleData]);

  const handleChartClick = useCallback((event) => {
    if (!cutMode) return;
    const label = event?.activeLabel;
    if (!label) return;
    if (!cutStart || (cutStart && cutEnd)) {
      setCutStart(label);
      setCutEnd(null);
      return;
    }
    setCutEnd(label);
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
        <h3>Basin Mean {label} Over Time</h3>
        <div className="graph-actions">
          <button
            type="button"
            className={`graph-cut-btn ${cutMode ? 'active' : ''}`}
            onClick={handleCutToggle}
            title="Cut (zoom) by date range"
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
        {stats && (
          <div className="graph-stats">
            <span className="stat">
              <span className="stat-label">
                Sample Period ({visibleData.length} days)
                {zoomRange ? `: ${zoomRange.start} to ${zoomRange.end}` : ''}
              </span>
            </span>
            <span className="stat">
              <span className="stat-label">Mean:</span>
              <span className="stat-value">{stats.mean.toFixed(2)}</span>
            </span>
            <span className="stat">
              <span className="stat-label">Min:</span>
              <span className="stat-value min">{stats.min.toFixed(2)}</span>
            </span>
            <span className="stat">
              <span className="stat-label">Max:</span>
              <span className="stat-value max">{stats.max.toFixed(2)}</span>
            </span>
            {showPointStats && Number.isFinite(stats.avgPoints) && (
              <span className="stat">
                <span className="stat-label">{pointsLabel}:</span>
                <span className="stat-value">{Math.round(stats.avgPoints).toLocaleString()}</span>
              </span>
            )}
          </div>
        )}
      </div>
      
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={visibleData}
          margin={{ top: 10, right: 30, left: 0, bottom: 40 }}
          onClick={handleChartClick}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis 
            dataKey="date" 
            stroke="var(--text-muted)"
            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            angle={-45}
            textAnchor="end"
            height={80}
            interval="preserveStartEnd"
          />
          <YAxis 
            stroke="var(--text-muted)"
            tick={{ fill: 'var(--text-muted)', fontSize: 12 }}
            label={{ 
              value: label, 
              angle: -90, 
              position: 'insideLeft',
              style: { fill: 'var(--text-muted)', fontSize: 13 }
            }}
          />
          <Tooltip content={<CustomTooltip />} />
          
          {currentDate && (
            <ReferenceLine 
              x={currentDate} 
              stroke={dangerColor} 
              strokeWidth={2}
              strokeDasharray="3 3"
              label={{ 
                value: 'Current', 
                position: 'top',
                fill: dangerColor,
                fontSize: 11
              }}
            />
          )}
          
          <Line 
            type="monotone" 
            dataKey="value" 
            stroke="var(--accent)" 
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 6, fill: 'var(--accent)' }}
            animationDuration={300}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default React.memo(TempGraph);
