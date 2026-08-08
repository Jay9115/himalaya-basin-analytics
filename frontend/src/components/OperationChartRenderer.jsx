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

const CHART_COLORS = ['#0072b2', '#d55e00', '#009e73', '#cc79a7', '#e69f00', '#56b4e9'];
const chartMargin = { top: 12, right: 24, left: 8, bottom: 24 };
const gridProps = { strokeDasharray: '2 4', stroke: 'var(--plot-grid)', vertical: false };
const tooltipProps = {
  contentStyle: {
    background: 'var(--tooltip-bg)',
    border: '1px solid var(--tooltip-border)',
    borderRadius: 6,
    color: 'var(--text)',
    boxShadow: '0 8px 24px var(--shadow)',
  },
  labelStyle: { color: 'var(--text)' },
};

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
          <Tooltip {...tooltipProps} />
          <Legend wrapperStyle={{ color: 'var(--text)', fontSize: 12 }} />
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
        <ScatterChart margin={chartMargin}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey={xKey} stroke="var(--plot-axis)" tick={{ fill: 'var(--plot-axis)', fontSize: tickSize }} />
          <YAxis dataKey={yKey} stroke="var(--plot-axis)" tick={{ fill: 'var(--plot-axis)', fontSize: tickSize }} width={axisWidth} />
          <Tooltip {...tooltipProps} />
          <Scatter data={data} fill={CHART_COLORS[0]} stroke="#ffffff" strokeWidth={0.8} />
        </ScatterChart>
      </ResponsiveContainer>
    );
  }

  if (chartType === 'bar' || chartType === 'histogram') {
    return (
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={chartMargin}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey={xKey} stroke="var(--plot-axis)" tick={{ fill: 'var(--plot-axis)', fontSize: tickSize }} />
          <YAxis stroke="var(--plot-axis)" tick={{ fill: 'var(--plot-axis)', fontSize: tickSize }} width={axisWidth} />
          <Tooltip {...tooltipProps} />
          <Legend wrapperStyle={{ color: 'var(--text)', fontSize: 12 }} />
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
        <AreaChart data={data} margin={chartMargin}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey={xKey} stroke="var(--plot-axis)" tick={{ fill: 'var(--plot-axis)', fontSize: tickSize }} />
          <YAxis stroke="var(--plot-axis)" tick={{ fill: 'var(--plot-axis)', fontSize: tickSize }} width={axisWidth} />
          <Tooltip {...tooltipProps} />
          <Legend wrapperStyle={{ color: 'var(--text)', fontSize: 12 }} />
          {series.map((key, index) => (
            <Area
              key={key}
              type="monotone"
              dataKey={key}
              stroke={CHART_COLORS[index % CHART_COLORS.length]}
              fill={CHART_COLORS[index % CHART_COLORS.length]}
              fillOpacity={0.16}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={chartMargin}>
        <CartesianGrid {...gridProps} />
        <XAxis dataKey={xKey} stroke="var(--plot-axis)" tick={{ fill: 'var(--plot-axis)', fontSize: tickSize }} />
        <YAxis stroke="var(--plot-axis)" tick={{ fill: 'var(--plot-axis)', fontSize: tickSize }} width={axisWidth} />
        <Tooltip {...tooltipProps} />
        <Legend wrapperStyle={{ color: 'var(--text)', fontSize: 12 }} />
        {series.map((key, index) => (
          <Line
            key={key}
            type="monotone"
            dataKey={key}
            stroke={CHART_COLORS[index % CHART_COLORS.length]}
            strokeWidth={2.2}
            dot={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export default OperationChartRenderer;
