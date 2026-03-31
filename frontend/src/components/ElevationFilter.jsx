import React, { useState, useCallback } from 'react';
import './ElevationFilter.css';

function ElevationFilter({ min, max, selectedMin, selectedMax, onChange }) {
  const [minValue, setMinValue] = useState(selectedMin);
  const [maxValue, setMaxValue] = useState(selectedMax);
  const [isCustom, setIsCustom] = useState(false);

  const handleMinChange = useCallback((e) => {
    const value = parseInt(e.target.value);
    setMinValue(value);
    if (value < maxValue) {
      onChange(value, maxValue);
    }
  }, [maxValue, onChange]);

  const handleMaxChange = useCallback((e) => {
    const value = parseInt(e.target.value);
    setMaxValue(value);
    if (value > minValue) {
      onChange(minValue, value);
    }
  }, [minValue, onChange]);

  const handleMinInput = useCallback((e) => {
    const value = parseInt(e.target.value) || min;
    setMinValue(value);
  }, [min]);

  const handleMaxInput = useCallback((e) => {
    const value = parseInt(e.target.value) || max;
    setMaxValue(value);
  }, [max]);

  const handleApply = useCallback(() => {
    if (minValue < maxValue) {
      onChange(minValue, maxValue);
    }
  }, [minValue, maxValue, onChange]);

  const handlePreset = useCallback((presetMin, presetMax) => {
    setMinValue(presetMin);
    setMaxValue(presetMax);
    onChange(presetMin, presetMax);
    setIsCustom(false);
  }, [onChange]);

  return (
    <div className="elevation-filter">
      <h3>🏔️ Elevation Filter</h3>
      
      {/* Preset buttons */}
      <div className="preset-buttons">
        <button
          className={`preset-btn ${!isCustom && minValue === min && maxValue === max ? 'active' : ''}`}
          onClick={() => handlePreset(min, max)}
        >
          All Elevations
        </button>
        <button
          className="preset-btn"
          onClick={() => handlePreset(min, 2000)}
        >
          Low (&lt; 2000m)
        </button>
        <button
          className="preset-btn"
          onClick={() => handlePreset(2000, 4000)}
        >
          Mid (2000-4000m)
        </button>
        <button
          className="preset-btn"
          onClick={() => handlePreset(4000, max)}
        >
          High (&gt; 4000m)
        </button>
        <button
          className={`preset-btn ${isCustom ? 'active' : ''}`}
          onClick={() => setIsCustom(true)}
        >
          Custom Range
        </button>
      </div>

      {/* Range sliders */}
      <div className="range-sliders">
        <div className="slider-group">
          <label>
            Minimum: <strong>{minValue}m</strong>
          </label>
          <input
            type="range"
            min={min}
            max={max}
            step="50"
            value={minValue}
            onChange={handleMinChange}
            className="elevation-slider"
            style={{
              background: `linear-gradient(to right, #4dabf7 0%, #4dabf7 ${((minValue - min) / (max - min)) * 100}%, #2d3748 ${((minValue - min) / (max - min)) * 100}%, #2d3748 100%)`
            }}
          />
        </div>

        <div className="slider-group">
          <label>
            Maximum: <strong>{maxValue}m</strong>
          </label>
          <input
            type="range"
            min={min}
            max={max}
            step="50"
            value={maxValue}
            onChange={handleMaxChange}
            className="elevation-slider"
            style={{
              background: `linear-gradient(to right, #4dabf7 0%, #4dabf7 ${((maxValue - min) / (max - min)) * 100}%, #2d3748 ${((maxValue - min) / (max - min)) * 100}%, #2d3748 100%)`
            }}
          />
        </div>
      </div>

      {/* Custom input */}
      {isCustom && (
        <div className="custom-input">
          <div className="input-group">
            <label>Min Elevation (m):</label>
            <input
              type="number"
              min={min}
              max={max}
              value={minValue}
              onChange={handleMinInput}
              className="elevation-input"
            />
          </div>
          <div className="input-group">
            <label>Max Elevation (m):</label>
            <input
              type="number"
              min={min}
              max={max}
              value={maxValue}
              onChange={handleMaxInput}
              className="elevation-input"
            />
          </div>
          <button className="apply-btn" onClick={handleApply}>
            Apply Range
          </button>
        </div>
      )}

      {/* Current range display */}
      <div className="current-range">
        <div className="range-bar">
          <div 
            className="range-fill"
            style={{
              left: `${((minValue - min) / (max - min)) * 100}%`,
              width: `${((maxValue - minValue) / (max - min)) * 100}%`
            }}
          />
        </div>
        <div className="range-labels">
          <span>{min}m</span>
          <span className="selected-range">
            {minValue}m - {maxValue}m
          </span>
          <span>{max}m</span>
        </div>
      </div>
    </div>
  );
}

export default React.memo(ElevationFilter);
