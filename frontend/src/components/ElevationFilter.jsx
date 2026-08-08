import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './ElevationFilter.css';

const clampValue = (value, min, max) => Math.min(Math.max(value, min), max);

function ElevationFilter({ min, max, selectedMin, selectedMax, onChange }) {
  const [minValue, setMinValue] = useState(selectedMin);
  const [maxValue, setMaxValue] = useState(selectedMax);
  const lastCommittedRef = useRef(`${selectedMin}:${selectedMax}`);
  const step = 50;

  useEffect(() => {
    setMinValue(selectedMin);
    setMaxValue(selectedMax);
    lastCommittedRef.current = `${selectedMin}:${selectedMax}`;
  }, [selectedMin, selectedMax]);

  const percent = useCallback((value) => {
    if (max <= min) return 0;
    return ((value - min) / (max - min)) * 100;
  }, [min, max]);

  const rangeStyle = useMemo(() => ({
    left: `${percent(minValue)}%`,
    width: `${Math.max(0, percent(maxValue) - percent(minValue))}%`,
  }), [minValue, maxValue, percent]);

  const updateDraftRange = useCallback((nextMin, nextMax) => {
    const safeMin = clampValue(nextMin, min, max);
    const safeMax = clampValue(nextMax, min, max);
    if (safeMin >= safeMax) return;
    setMinValue(safeMin);
    setMaxValue(safeMax);
  }, [min, max]);

  const commitRange = useCallback((nextMin, nextMax) => {
    const key = `${nextMin}:${nextMax}`;
    if (key === lastCommittedRef.current) return;
    lastCommittedRef.current = key;
    onChange(nextMin, nextMax);
  }, [onChange]);

  // Keep the handles responsive while avoiding a new map + graph query for
  // every single pointer pixel during a drag.
  useEffect(() => {
    const timer = window.setTimeout(() => commitRange(minValue, maxValue), 180);
    return () => window.clearTimeout(timer);
  }, [minValue, maxValue, commitRange]);

  const handleMinChange = useCallback((event) => {
    const nextMin = Number.parseInt(event.target.value, 10);
    if (!Number.isInteger(nextMin)) return;
    updateDraftRange(Math.min(nextMin, maxValue - step), maxValue);
  }, [updateDraftRange, maxValue]);

  const handleMaxChange = useCallback((event) => {
    const nextMax = Number.parseInt(event.target.value, 10);
    if (!Number.isInteger(nextMax)) return;
    updateDraftRange(minValue, Math.max(nextMax, minValue + step));
  }, [updateDraftRange, minValue]);

  const commitCurrentRange = useCallback(() => {
    commitRange(minValue, maxValue);
  }, [commitRange, minValue, maxValue]);

  return (
    <div className="elevation-filter">
      <div className="elevation-filter-header">
        <h3>Elevation Filter</h3>
        <div className="elevation-range-readout">
          {minValue}m - {maxValue}m
        </div>
      </div>

      <div className="dual-range-wrap">
        <div className="dual-range-track">
          <div className="dual-range-fill" style={rangeStyle} />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={minValue}
          onChange={handleMinChange}
          onPointerUp={commitCurrentRange}
          onKeyUp={commitCurrentRange}
          onBlur={commitCurrentRange}
          className="dual-range-input dual-range-min"
          aria-label="Minimum elevation"
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={maxValue}
          onChange={handleMaxChange}
          onPointerUp={commitCurrentRange}
          onKeyUp={commitCurrentRange}
          onBlur={commitCurrentRange}
          className="dual-range-input dual-range-max"
          aria-label="Maximum elevation"
        />
      </div>

      <div className="range-labels compact">
        <span>{min}m</span>
        <span className="selected-range">Selected range</span>
        <span>{max}m</span>
      </div>
    </div>
  );
}

export default React.memo(ElevationFilter);
