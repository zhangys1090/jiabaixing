import React from 'react';
import './PanelSkeleton.css';

interface PanelSkeletonProps {
  /** Number of stats cards at top */
  statsCount?: number;
  /** Number of sections (each with title + 2-3 rows) */
  sectionCount?: number;
  /** Number of form rows per section */
  rowsPerSection?: number;
  /** Whether to show tabs */
  hasTabs?: boolean;
  /** Number of tabs */
  tabCount?: number;
}

export const PanelSkeleton: React.FC<PanelSkeletonProps> = ({
  statsCount = 0,
  sectionCount = 2,
  rowsPerSection = 3,
  hasTabs = false,
  tabCount = 3,
}) => {
  return (
    <div className="panel-skeleton">
      {/* Header */}
      <div className="panel-skeleton__header">
        <div className="panel-skeleton__title" />
        <div className="panel-skeleton__subtitle" />
      </div>

      {/* Tabs */}
      {hasTabs && (
        <div className="panel-skeleton__tabs">
          {Array.from({ length: tabCount }).map((_, i) => (
            <div key={i} className="panel-skeleton__tab" />
          ))}
        </div>
      )}

      {/* Stats */}
      {statsCount > 0 && (
        <div className="panel-skeleton__stats">
          {Array.from({ length: statsCount }).map((_, i) => (
            <div key={i} className="panel-skeleton__stat-card">
              <div className="panel-skeleton__stat-value" />
              <div className="panel-skeleton__stat-label" />
            </div>
          ))}
        </div>
      )}

      {/* Sections */}
      {Array.from({ length: sectionCount }).map((_, si) => (
        <div key={si} className="panel-skeleton__section">
          <div className="panel-skeleton__section-title" />
          {Array.from({ length: rowsPerSection }).map((_, ri) => (
            <div key={ri} className="panel-skeleton__row">
              <div className="panel-skeleton__label" />
              <div className="panel-skeleton__input" />
            </div>
          ))}
          <div className="panel-skeleton__actions">
            <div className="panel-skeleton__btn panel-skeleton__btn--primary" />
            <div className="panel-skeleton__btn" />
          </div>
        </div>
      ))}
    </div>
  );
};

export default PanelSkeleton;
