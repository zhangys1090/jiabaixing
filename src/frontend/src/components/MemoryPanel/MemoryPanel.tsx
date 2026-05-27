import React, { useCallback, useEffect, useState } from 'react';
import './MemoryPanel.css';
import { apiService } from '../../api/apiService';
import { useMemoryStore } from '../../stores/useMemoryStore';
import type { MemorySearchResponse, MemoryProfileResponse, MemoryStatsResponse } from '@shared/contracts';

type MemoryTab = 'short' | 'long' | 'search' | 'profile' | 'stats';

export const MemoryPanel: React.FC = () => {
  const [activeTab, setActiveTab] = useState<MemoryTab>('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MemorySearchResponse | null>(null);
  const [stats, setStats] = useState<MemoryStatsResponse | null>(null);
  const [profile, setProfile] = useState<MemoryProfileResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    const result = await apiService.searchMemory(searchQuery);
    if (result.success && result.data) {
      setSearchResults(result.data);
    }
    setLoading(false);
  }, [searchQuery]);

  const loadStats = useCallback(async () => {
    const result = await apiService.getMemoryStats();
    if (result.success && result.data) {
      setStats(result.data);
    }
  }, []);

  const loadProfile = useCallback(async () => {
    const result = await apiService.getMemoryProfile();
    if (result.success && result.data) {
      setProfile(result.data);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'stats' && !stats) loadStats();
    if (activeTab === 'profile' && !profile) loadProfile();
  }, [activeTab, stats, profile, loadStats, loadProfile]);

  return (
    <div className="memory-panel">
      <input
        className="memory-panel__search-input"
        placeholder="搜索记忆..."
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
      />

      <div className="memory-panel__tab-bar">
        <button
          className={`memory-panel__tab${activeTab === 'search' ? ' memory-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('search')}
        >
          搜索
        </button>
        <button
          className={`memory-panel__tab${activeTab === 'profile' ? ' memory-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('profile')}
        >
          画像
        </button>
        <button
          className={`memory-panel__tab${activeTab === 'stats' ? ' memory-panel__tab--active' : ''}`}
          onClick={() => setActiveTab('stats')}
        >
          统计
        </button>
      </div>

      <div className="memory-panel__scrollable-content">
        {activeTab === 'search' && (
          <div className="memory-panel__section">
            <div className="memory-panel__section-title">搜索结果</div>
            {loading && <div className="memory-panel__hint">搜索中...</div>}
            {searchResults && searchResults.results.length === 0 && (
              <div className="memory-panel__hint">无匹配结果</div>
            )}
            {searchResults?.results.map(
              (
                item: {
                  id?: string;
                  content: string;
                  importance: string;
                  similarity: number;
                },
                i: number
              ) => (
                <div className="memory-panel__memory-item" key={item.id || i}>
                  <span className="memory-panel__memory-content">{item.content}</span>
                  <span className="memory-panel__memory-time">
                    {item.importance} · {(item.similarity * 100).toFixed(0)}%
                  </span>
                </div>
              )
            )}
          </div>
        )}

        {activeTab === 'profile' && (
          <div className="memory-panel__section">
            <div className="memory-panel__section-title">用户画像</div>
            {profile ? (
              <pre className="memory-panel__pre">{JSON.stringify(profile, null, 2)}</pre>
            ) : (
              <div className="memory-panel__hint">加载中...</div>
            )}
          </div>
        )}

        {activeTab === 'stats' && (
          <div className="memory-panel__section">
            <div className="memory-panel__section-title">记忆统计</div>
            {stats ? (
              <div className="memory-panel__stats-grid">
                <div className="memory-panel__stat-item">
                  <div className="memory-panel__stat-label">总记录</div>
                  <div className="memory-panel__stat-value">{stats.totalRecords}</div>
                </div>
                <div className="memory-panel__stat-item">
                  <div className="memory-panel__stat-label">数据库大小</div>
                  <div className="memory-panel__stat-value">{stats.databaseSizeMB.toFixed(1)}MB</div>
                </div>
                {Object.entries(stats.typeDistribution as Record<string, string | number>).map(([type, count]) => (
                  <div className="memory-panel__stat-item" key={type}>
                    <div className="memory-panel__stat-label">{type}</div>
                    <div className="memory-panel__stat-value">{count}</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="memory-panel__hint">加载中...</div>
            )}
          </div>
        )}

        <div className="memory-panel__action-row">
          <button className="memory-panel__action-button" onClick={handleSearch}>
            搜索
          </button>
          <button className="memory-panel__action-button" onClick={loadStats}>
            刷新统计
          </button>
        </div>
      </div>
    </div>
  );
};
