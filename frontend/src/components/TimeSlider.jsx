import React, { useCallback } from 'react';
import './TimeSlider.css';

function TimeSlider({ 
  dates, 
  currentIndex, 
  isPlaying, 
  playSpeed, 
  onDateChange, 
  onPlayPause, 
  onSpeedChange 
}) {
  
  const handleSliderChange = useCallback((e) => {
    const index = parseInt(e.target.value);
    onDateChange(index);
  }, [onDateChange]);

  const handlePrevious = useCallback(() => {
    if (currentIndex > 0) {
      onDateChange(currentIndex - 1);
    }
  }, [currentIndex, onDateChange]);

  const handleNext = useCallback(() => {
    if (currentIndex < dates.length - 1) {
      onDateChange(currentIndex + 1);
    }
  }, [currentIndex, dates.length, onDateChange]);

  const handleSpeedSelect = useCallback((speed) => {
    onSpeedChange(speed);
  }, [onSpeedChange]);

  const currentDate = dates[currentIndex] || '';

  return (
    <div className="time-slider">
      <div className="playback-controls">
        <button 
          className="control-btn" 
          onClick={handlePrevious}
          disabled={currentIndex === 0}
          title="Previous day"
          type="button"
        >
          Prev
        </button>
        
        <button 
          className="control-btn play-btn" 
          onClick={onPlayPause}
          title={isPlaying ? 'Pause' : 'Play'}
          type="button"
        >
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        
        <button 
          className="control-btn" 
          onClick={handleNext}
          disabled={currentIndex === dates.length - 1}
          title="Next day"
          type="button"
        >
          Next
        </button>
      </div>

      <div className="slider-container">
        <div className="slider-label">
          <span>{dates[0]}</span>
          <span className="current-date-display">{currentDate}</span>
          <span>{dates[dates.length - 1]}</span>
        </div>
        <input
          type="range"
          min="0"
          max={dates.length - 1}
          value={currentIndex}
          onChange={handleSliderChange}
          className="date-slider"
          style={{
            background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${(currentIndex / (dates.length - 1)) * 100}%, var(--border) ${(currentIndex / (dates.length - 1)) * 100}%, var(--border) 100%)`
          }}
        />
        <div className="slider-info">
          Day {currentIndex + 1} of {dates.length}
        </div>
      </div>

      <div className="speed-controls">
        <span className="speed-label">Speed:</span>
        <button 
          className={`speed-btn ${playSpeed === 1000 ? 'active' : ''}`}
          onClick={() => handleSpeedSelect(1000)}
        >
          0.5x
        </button>
        <button 
          className={`speed-btn ${playSpeed === 500 ? 'active' : ''}`}
          onClick={() => handleSpeedSelect(500)}
        >
          1x
        </button>
        <button 
          className={`speed-btn ${playSpeed === 250 ? 'active' : ''}`}
          onClick={() => handleSpeedSelect(250)}
        >
          2x
        </button>
        <button 
          className={`speed-btn ${playSpeed === 100 ? 'active' : ''}`}
          onClick={() => handleSpeedSelect(100)}
        >
          5x
        </button>
      </div>

      <div className="date-input-container">
        <label htmlFor="date-input">Jump to date:</label>
        <input
          id="date-input"
          type="date"
          value={currentDate}
          min={dates[0]}
          max={dates[dates.length - 1]}
          onChange={(e) => {
            const selectedDate = e.target.value;
            const index = dates.indexOf(selectedDate);
            if (index !== -1) {
              onDateChange(index);
            }
          }}
          className="date-input"
        />
      </div>
    </div>
  );
}

export default React.memo(TimeSlider);
