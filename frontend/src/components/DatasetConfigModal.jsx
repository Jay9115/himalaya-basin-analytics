import React, { useState, useEffect, useCallback } from 'react';
import apiService from '../services/api';
import './DatasetConfigModal.css';

function DatasetConfigModal({ open, onClose, onPathConfigured }) {
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [config, setConfig] = useState(null);
  const [inputPath, setInputPath] = useState('');
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiService.getDatasetConfig();
      setConfig(data);
      if (!inputPath && data?.database_dir) {
        setInputPath(data.database_dir);
      }
    } catch (err) {
      console.error('Failed to get dataset config:', err);
      setError('Could not retrieve dataset configuration from backend.');
    } finally {
      setLoading(false);
    }
  }, [inputPath]);

  useEffect(() => {
    if (open) {
      fetchConfig();
      setSuccessMsg('');
    }
  }, [open, fetchConfig]);

  const handleSubmit = async (e) => {
    if (e) e.preventDefault();
    const trimmed = inputPath.trim();
    if (!trimmed) {
      setError('Please enter a valid directory path.');
      return;
    }
    setSubmitting(true);
    setError('');
    setSuccessMsg('');
    try {
      const res = await apiService.setDatasetPath(trimmed);
      if (res.success) {
        setConfig(res);
        setSuccessMsg(`Successfully connected! Found ${res.total_files} files across ${res.ready_datasets} active datasets.`);
        if (onPathConfigured) {
          onPathConfigured(res.datasets, res.database_dir);
        }
        setTimeout(() => {
          if (onClose) onClose();
        }, 1200);
      }
    } catch (err) {
      console.error('Failed to set dataset path:', err);
      const detail = err.response?.data?.detail || err.message || 'Failed to update dataset path.';
      setError(detail);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUseDefault = () => {
    if (config?.default_database_dir) {
      setInputPath(config.default_database_dir);
    }
  };

  if (!open) return null;

  const isEmpty = config ? config.is_empty : true;
  const datasets = config?.datasets || [];

  return (
    <div className="dataset-modal-backdrop" onClick={onClose}>
      <div className="dataset-modal-panel" onClick={(e) => e.stopPropagation()}>
        <div className="dataset-modal-header">
          <div className="dataset-modal-title-wrap">
            <svg className="dataset-modal-icon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
            </svg>
            <div>
              <span className="dataset-modal-title">Dataset Storage Location</span>
              <div className="dataset-modal-subtitle">
                {isEmpty ? (
                  <span className="dataset-status-warning">⚠️ No dataset files detected in current folder</span>
                ) : (
                  <span className="dataset-status-ok">✅ {config?.ready_datasets || 0} active datasets connected</span>
                )}
              </div>
            </div>
          </div>
          <button className="dataset-modal-close" onClick={onClose} title="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>

        <div className="dataset-modal-body">
          {isEmpty && (
            <div className="dataset-notice-box">
              <span className="dataset-notice-icon">💡</span>
              <div className="dataset-notice-text">
                The application is running in portable mode without bundled data payloads.
                Please provide the path to your dataset folder containing Parquet or GeoTIFF files on this computer.
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="dataset-form">
            <label className="dataset-input-label">
              <span>Database Directory Path</span>
              <div className="dataset-input-row">
                <input
                  type="text"
                  className="dataset-path-input"
                  placeholder="e.g. D:\ISRO-SWOT\Database"
                  value={inputPath}
                  onChange={(e) => setInputPath(e.target.value)}
                  disabled={submitting}
                  autoFocus
                />
                <button
                  type="submit"
                  className="dataset-connect-btn"
                  disabled={submitting || !inputPath.trim()}
                >
                  {submitting ? 'Connecting...' : 'Connect Folder'}
                </button>
              </div>
            </label>

            <div className="dataset-quick-links">
              {config?.default_database_dir && config.default_database_dir !== inputPath && (
                <button
                  type="button"
                  className="dataset-quick-chip"
                  onClick={handleUseDefault}
                  title="Reset path to default internal Database folder"
                >
                  Reset to Default ({config.default_database_dir.split(/[/\\]/).pop()})
                </button>
              )}
            </div>
          </form>

          {error && (
            <div className="dataset-alert error">
              <span>✕</span>
              <span>{error}</span>
            </div>
          )}

          {successMsg && (
            <div className="dataset-alert success">
              <span>✓</span>
              <span>{successMsg}</span>
            </div>
          )}

          {/* Dataset Status Breakdown */}
          <div className="dataset-breakdown-section">
            <div className="dataset-breakdown-title">
              <span>Detected Datasets ({datasets.length})</span>
              <span className="dataset-files-count">
                {config?.total_files || 0} total files
              </span>
            </div>

            {loading ? (
              <div className="dataset-loading-state">Scanning dataset directories...</div>
            ) : (
              <div className="dataset-list-grid">
                {datasets.map((d) => (
                  <div key={d.id} className={`dataset-status-card ${d.ready ? 'is-ready' : 'is-empty'}`}>
                    <div className="dataset-card-header">
                      <span className="dataset-card-name" title={d.label}>{d.label}</span>
                      <span className={`dataset-card-pill ${d.ready ? 'ready' : 'empty'}`}>
                        {d.ready ? 'Ready' : 'Empty'}
                      </span>
                    </div>
                    <div className="dataset-card-stats">
                      {d.storage === 'geotiff' ? (
                        <span>{d.geotiff_files || 0} GeoTIFFs</span>
                      ) : (
                        <span>{d.parquet_files || 0} Parquet files</span>
                      )}
                    </div>
                    <div className="dataset-card-path" title={d.path}>
                      {d.path.split(/[/\\]/).slice(-2).join('/')}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="dataset-modal-footer">
          <button type="button" className="dataset-btn-cancel" onClick={onClose}>
            {isEmpty ? 'Dismiss & Configure Later' : 'Close'}
          </button>
          <button
            type="button"
            className="dataset-btn-primary"
            onClick={handleSubmit}
            disabled={submitting || !inputPath.trim()}
          >
            {submitting ? 'Connecting...' : 'Apply Path'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default DatasetConfigModal;
