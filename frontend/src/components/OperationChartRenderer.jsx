import React from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const CHART_COLORS = ['#0f766e', '#2563eb', '#dc2626', '#ca8a04', '#7c3aed', '#ea580c'];

const withFallbackData = (output) => output?.points || [];

const seriesListFor = (output) => {
  if (Array.isArray(output?.series) && output.series.length) {
    return output.series;
  }
  if (output?.y) {
    return [output.y];
  }
  if (output?.value) {
    return [output.value];
  }
  return ['value'];
};

function OperationChartRenderer({ output, height = 240, compact = false }) {
  const chartType = String(output?.chart_type || 'line').toLowerCase();
  const data = withFallbackData(output);
  const xKey = output?.x || output?.category || 'x';
  const yKey = output?.y || output?.value || 'value';
  const series = seriesListFor(output);
  const tickSize = compact ? 10 : 11;
  const axisWidth = compact ? 58 : 64;

  if (!data.length) {
    return <div className="empty-output">No chart points.</div>;
  }

  if (chartType === 'pie') {
    const nameKey = output?.category || xKey;
    const valueKey = output?.value || yKey;
    return (
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Tooltip />
          <Legend />
          <Pie data={data} dataKey={valueKey} nameKey={nameKey} outerRadius="72%">
            {data.map((item, index) => (
              <Cell key={`${item[nameKey]}-${index}`} fill={CHART_COLORS[index % CHART_COLORS.length]} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'scatter') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <ScatterChart>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey={xKey} stroke="var(--text-muted)" tick={{ fontSize: tickSize }} />
          <YAxis dataKey={yKey} stroke="var(--text-muted)" tick={{ fontSize: tickSize }} width={axisWidth} />
          <Tooltip />
          <Scatter data={data} fill={CHART_COLORS[0]} />
        </ScatterChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'bar' || chartType === 'histogram') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey={xKey} stroke="var(--text-muted)" tick={{ fontSize: tickSize }} />
          <YAxis stroke="var(--text-muted)" tick={{ fontSize: tickSize }} width={axisWidth} />
          <Tooltip />
          <Legend />
          {series.map((key, index) => (
            <Bar key={key} dataKey={key} fill={CHART_COLORS[index % CHART_COLORS.length]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'area') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey={xKey} stroke="var(--text-muted)" tick={{ fontSize: tickSize }} />
          <YAxis stroke="var(--text-muted)" tick={{ fontSize: tickSize }} width={axisWidth} />
          <Tooltip />
          <Legend />
          {series.map((key, index) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stroke={CHART_COLORS[index % CHART_COLORS.length]}
              fill={CHART_COLORS[index % CHART_COLORS.length]}
              fillOpacity={0.2}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey={xKey} stroke="var(--text-muted)" tick={{ fontSize: tickSize }} />
        <YAxis stroke="var(--text-muted)" tick={{ fontSize: tickSize }} width={axisWidth} />
        <Tooltip />
        <Legend />
        {series.map((key, index) => (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            stroke={CHART_COLORS[index % CHART_COLORS.length]}
            strokeWidth={2}
            dot={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export default OperationChartRenderer;
