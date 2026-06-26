/**
 * P1-2: 情景记忆存储 — 从 Python EpisodicMemoryStore 迁移
 *
 * 存储带有场景(scene)、情绪(emotion)、重要性(importance)等
 * 元数据的情景记忆，支持时间衰减、相关性检索和聚类分析。
 *
 * 迁移自: python/agent/memory/episodic_memory.py
 * 迁移日期: 2026-06-26
 */

import { Logger } from '../utils/Logger';
import { BaseMemoryStore } from './BaseMemoryStore';

const LOG_MODULE = 'EpisodicMemoryStore';

const MAX_EPISODES = 500;
const DEFAULT_DECAY_HOURS = 24.0;
const IMPORTANCE_THRESHOLD = 7.0;

export enum EmotionType {
  HAPPY = 'happy',
  SAD = 'sad',
  ANGRY = 'angry',
  FEARFUL = 'fearful',
  SURPRISED = 'surprised',
  DISGUSTED = 'disgusted',
  NEUTRAL = 'neutral',
  FOCUSED = 'focused',
  CALM = 'calm',
}

export enum SceneType {
  DEVELOPMENT = 'development',
  DAILY = 'daily',
  LEARNING = 'learning',
  WORK = 'work',
  SOCIAL = 'social',
  ENTERTAINMENT = 'entertainment',
  OTHER = 'other',
}

export interface EpisodicMemory {
  id: string;
  content: string;
  scene: SceneType;
  emotion: EmotionType;
  emotionIntensity: number;
  timestamp: number;
  importance: number;
  accessCount: number;
  lastAccessed: number;
  tags: string[];
  metadata: Record<string, unknown>;
  decayScore: number;
}

export interface EpisodeCluster {
  scene: SceneType;
  emotion?: EmotionType;
  memories: EpisodicMemory[];
  startTime: number;
  endTime: number;
  summary: string;
}

export interface RetrievalResult {
  memories: EpisodicMemory[];
  query: string;
  totalFound: number;
  retrievalTimeMs: number;
}

export interface StoreOptions {
  scene?: SceneType | string;
  emotion?: EmotionType | string;
  emotionIntensity?: number;
  importance?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface RetrieveOptions {
  query?: string;
  scene?: SceneType | string;
  emotion?: EmotionType | string;
  limit?: number;
  minImportance?: number;
  since?: number;
  until?: number;
}

function normalizeScene(scene: SceneType | string): SceneType {
  if (typeof scene === 'string') {
    const lower = scene.toLowerCase();
    return Object.values(SceneType).includes(lower as SceneType)
      ? (lower as SceneType)
      : SceneType.OTHER;
  }
  return scene;
}

function normalizeEmotion(emotion: EmotionType | string): EmotionType {
  if (typeof emotion === 'string') {
    const lower = emotion.toLowerCase();
    return Object.values(EmotionType).includes(lower as EmotionType)
      ? (lower as EmotionType)
      : EmotionType.NEUTRAL;
  }
  return emotion;
}

function generateId(): string {
  return `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export class EpisodicMemoryStore extends BaseMemoryStore {
  private episodes: EpisodicMemory[] = [];
  private storagePath: string;

  constructor(storagePath: string = './data/episodic_memory.json') {
    super({
      enableOperationLogging: true,
      enableErrorRetry: true,
      maxRetryAttempts: 2,
    });
    this.storagePath = storagePath;
  }

  protected getStoreName(): string {
    return '情景记忆';
  }

  public async initialize(): Promise<void> {
    await this.executeTransaction('initialize', async () => {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const dataDir = path.dirname(this.storagePath);

        try {
          await fs.promises.access(dataDir);
        } catch {
          await fs.promises.mkdir(dataDir, { recursive: true });
        }

        try {
          const data = await fs.promises.readFile(this.storagePath, 'utf-8');
          const parsed = JSON.parse(data);
          if (Array.isArray(parsed)) {
            this.episodes = parsed.map((e: Record<string, unknown>) =>
              this.deserializeEpisode(e)
            );
          }
        } catch {
          this.episodes = [];
        }
      } catch (error) {
        Logger.warn(
          'Failed to load episodic memory from file',
          LOG_MODULE,
          error
        );
        this.episodes = [];
      }

      this.initialized = true;
      Logger.info('EpisodicMemoryStore initialized', LOG_MODULE, {
        episodeCount: this.episodes.length,
      });
    });
  }

  public async shutdown(): Promise<void> {
    await this.persist();
    this.initialized = false;
  }

  public async store(
    content: string,
    options: StoreOptions = {}
  ): Promise<EpisodicMemory> {
    this.ensureInitialized();

    const now = Date.now() / 1000;
    const episode: EpisodicMemory = {
      id: generateId(),
      content,
      scene: normalizeScene(options.scene ?? SceneType.OTHER),
      emotion: normalizeEmotion(options.emotion ?? EmotionType.NEUTRAL),
      emotionIntensity: Math.max(
        0,
        Math.min(1, options.emotionIntensity ?? 0.5)
      ),
      timestamp: now,
      importance: Math.max(1, Math.min(10, options.importance ?? 5.0)),
      accessCount: 0,
      lastAccessed: now,
      tags: options.tags ?? [],
      metadata: options.metadata ?? {},
      decayScore: 1.0,
    };

    this.episodes.push(episode);

    if (this.episodes.length > MAX_EPISODES) {
      this.cleanupOld();
    }

    Logger.debug('Episode stored', LOG_MODULE, {
      id: episode.id,
      scene: episode.scene,
    });
    await this.persist();
    return episode;
  }

  public retrieve(options: RetrieveOptions = {}): RetrievalResult {
    this.ensureInitialized();

    const startTime = Date.now();
    const {
      query = '',
      scene,
      emotion,
      limit = 20,
      minImportance = 0,
      since = 0,
      until = 0,
    } = options;

    let candidates = [...this.episodes];

    if (scene !== undefined) {
      const normalizedScene = normalizeScene(scene);
      candidates = candidates.filter((e) => e.scene === normalizedScene);
    }

    if (emotion !== undefined) {
      const normalizedEmotion = normalizeEmotion(emotion);
      candidates = candidates.filter((e) => e.emotion === normalizedEmotion);
    }

    if (minImportance > 0) {
      candidates = candidates.filter((e) => e.importance >= minImportance);
    }

    if (since > 0) {
      candidates = candidates.filter((e) => e.timestamp >= since);
    }

    if (until > 0) {
      candidates = candidates.filter((e) => e.timestamp <= until);
    }

    if (query) {
      const queryLower = query.toLowerCase();
      for (const ep of candidates) {
        ep.decayScore = this.calculateRelevance(ep, queryLower);
      }
      candidates.sort((a, b) => b.decayScore - a.decayScore);
    } else {
      for (const ep of candidates) {
        ep.decayScore = this.calculateDecayScore(ep);
      }
      candidates.sort(
        (a, b) => b.decayScore - a.decayScore || b.importance - a.importance
      );
    }

    const resultMemories = candidates.slice(0, limit);
    const now = Date.now() / 1000;

    for (const mem of resultMemories) {
      mem.accessCount += 1;
      mem.lastAccessed = now;
    }

    const elapsed = Date.now() - startTime;
    return {
      memories: resultMemories,
      query,
      totalFound: candidates.length,
      retrievalTimeMs: elapsed,
    };
  }

  public getById(memoryId: string): EpisodicMemory | undefined {
    return this.episodes.find((e) => e.id === memoryId);
  }

  public updateImportance(memoryId: string, delta: number): boolean {
    const ep = this.getById(memoryId);
    if (!ep) return false;
    ep.importance = Math.max(1, Math.min(10, ep.importance + delta));
    Logger.debug('Importance updated', LOG_MODULE, {
      id: memoryId,
      newImportance: ep.importance,
    });
    return true;
  }

  public addTag(memoryId: string, tag: string): boolean {
    const ep = this.getById(memoryId);
    if (!ep || ep.tags.includes(tag)) return false;
    ep.tags.push(tag);
    return true;
  }

  public delete(memoryId: string): boolean {
    const originalLen = this.episodes.length;
    this.episodes = this.episodes.filter((e) => e.id !== memoryId);
    return this.episodes.length < originalLen;
  }

  public clusterByScene(): Map<SceneType, EpisodeCluster> {
    const groups = new Map<SceneType, EpisodicMemory[]>();
    for (const ep of this.episodes) {
      const list = groups.get(ep.scene) ?? [];
      list.push(ep);
      groups.set(ep.scene, list);
    }

    const result = new Map<SceneType, EpisodeCluster>();
    for (const [scene, episodes] of groups) {
      const timestamps = episodes.map((e) => e.timestamp);
      const sorted = [...episodes].sort((a, b) => a.timestamp - b.timestamp);
      result.set(scene, {
        scene,
        memories: sorted,
        startTime: timestamps.length > 0 ? Math.min(...timestamps) : 0,
        endTime: timestamps.length > 0 ? Math.max(...timestamps) : 0,
        summary: `${episodes.length} episodes in ${scene}`,
      });
    }
    return result;
  }

  public clusterByEmotion(): Map<EmotionType, EpisodeCluster> {
    const groups = new Map<EmotionType, EpisodicMemory[]>();
    for (const ep of this.episodes) {
      const list = groups.get(ep.emotion) ?? [];
      list.push(ep);
      groups.set(ep.emotion, list);
    }

    const result = new Map<EmotionType, EpisodeCluster>();
    for (const [emotion, episodes] of groups) {
      const timestamps = episodes.map((e) => e.timestamp);
      const sorted = [...episodes].sort((a, b) => a.timestamp - b.timestamp);
      result.set(emotion, {
        scene: SceneType.OTHER,
        emotion,
        memories: sorted,
        startTime: timestamps.length > 0 ? Math.min(...timestamps) : 0,
        endTime: timestamps.length > 0 ? Math.max(...timestamps) : 0,
        summary: `${episodes.length} episodes with ${emotion}`,
      });
    }
    return result;
  }

  public getRecent(limit: number = 10): EpisodicMemory[] {
    return [...this.episodes]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  public getImportant(limit: number = 10): EpisodicMemory[] {
    return this.episodes
      .filter((e) => e.importance >= IMPORTANCE_THRESHOLD)
      .sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  public getStats(): Record<string, unknown> {
    const scenes: Record<string, number> = {};
    const emotions: Record<string, number> = {};

    for (const ep of this.episodes) {
      scenes[ep.scene] = (scenes[ep.scene] ?? 0) + 1;
      emotions[ep.emotion] = (emotions[ep.emotion] ?? 0) + 1;
    }

    const totalAccess = this.episodes.reduce(
      (sum, e) => sum + e.accessCount,
      0
    );
    const avgImportance =
      this.episodes.length > 0
        ? this.episodes.reduce((sum, e) => sum + e.importance, 0) /
          this.episodes.length
        : 0;

    return {
      totalEpisodes: this.episodes.length,
      scenes,
      emotions,
      avgImportance: Math.round(avgImportance * 100) / 100,
      totalAccessCount: totalAccess,
      importantCount: this.episodes.filter(
        (e) => e.importance >= IMPORTANCE_THRESHOLD
      ).length,
    };
  }

  private calculateRelevance(
    episode: EpisodicMemory,
    queryLower: string
  ): number {
    const contentLower = episode.content.toLowerCase();

    const exactMatch = contentLower.includes(queryLower) ? 1.0 : 0.0;

    const queryWords = new Set(queryLower.split(/\s+/));
    const contentWords = new Set(contentLower.split(/\s+/));
    const wordOverlap =
      queryWords.size > 0
        ? [...queryWords].filter((w) => contentWords.has(w)).length /
          queryWords.size
        : 0;

    const tagMatch = episode.tags.some((tag) =>
      tag.toLowerCase().includes(queryLower)
    );

    const relevance =
      (exactMatch * 0.5 + wordOverlap * 0.3 + (tagMatch ? 0.2 : 0)) *
      (episode.importance / 10.0);

    const decay = this.calculateDecayScore(episode);
    return relevance * decay;
  }

  private calculateDecayScore(episode: EpisodicMemory): number {
    const now = Date.now() / 1000;
    const hoursSince = (now - episode.timestamp) / 3600;
    const timeDecay = 1.0 / (1.0 + hoursSince / DEFAULT_DECAY_HOURS);
    const accessBoost = 1.0 + episode.accessCount * 0.05;
    const importanceFactor = episode.importance / 10.0;
    return timeDecay * accessBoost * importanceFactor;
  }

  private cleanupOld(): void {
    for (const ep of this.episodes) {
      ep.decayScore = this.calculateDecayScore(ep);
    }
    this.episodes.sort((a, b) => a.decayScore - b.decayScore);
    const toRemove = this.episodes.length - MAX_EPISODES;
    if (toRemove > 0) {
      this.episodes = this.episodes.slice(toRemove);
      Logger.info('Old episodes cleaned', LOG_MODULE, { count: toRemove });
    }
  }

  private async persist(): Promise<void> {
    try {
      const fs = await import('fs');
      const data = JSON.stringify(
        this.episodes.map((e) => this.serializeEpisode(e)),
        null,
        2
      );
      await fs.promises.writeFile(this.storagePath, data, 'utf-8');
    } catch (error) {
      Logger.warn('Failed to persist episodic memory', LOG_MODULE, error);
    }
  }

  private serializeEpisode(ep: EpisodicMemory): Record<string, unknown> {
    return {
      id: ep.id,
      content: ep.content,
      scene: ep.scene,
      emotion: ep.emotion,
      emotionIntensity: ep.emotionIntensity,
      timestamp: ep.timestamp,
      importance: ep.importance,
      accessCount: ep.accessCount,
      lastAccessed: ep.lastAccessed,
      tags: ep.tags,
      metadata: ep.metadata,
      decayScore: ep.decayScore,
    };
  }

  private deserializeEpisode(data: Record<string, unknown>): EpisodicMemory {
    return {
      id: (data.id as string) ?? generateId(),
      content: (data.content as string) ?? '',
      scene: normalizeScene((data.scene as string) ?? SceneType.OTHER),
      emotion: normalizeEmotion(
        (data.emotion as string) ?? EmotionType.NEUTRAL
      ),
      emotionIntensity: (data.emotionIntensity as number) ?? 0.5,
      timestamp: (data.timestamp as number) ?? 0,
      importance: (data.importance as number) ?? 5.0,
      accessCount: (data.accessCount as number) ?? 0,
      lastAccessed: (data.lastAccessed as number) ?? 0,
      tags: (data.tags as string[]) ?? [],
      metadata: (data.metadata as Record<string, unknown>) ?? {},
      decayScore: (data.decayScore as number) ?? 1.0,
    };
  }
}
