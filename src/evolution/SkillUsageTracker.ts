/**
 * SkillUsageTracker — 记录每次 auto-generated skill 的加载和使用情况
 *
 * 功能：
 * 1. trackLoad() — skill 被加载/查看时记录
 * 2. trackUse() — skill 被实际用于任务时记录
 * 3. getStats() — 返回使用统计（谁在用、多久用一次）
 * 4. getLeastUsed() — 返回不常用的 skill，供 EvolutionEngine 参考是否优化
 *
 * 数据持久化到 data/evolution/skill-usage.json
 */

import { Logger } from '../utils/Logger';
import * as fs from 'fs';
import * as path from 'path';

interface SkillUsageRecord {
  name: string;
  path: string;
  createdAt: string;
  lastLoadedAt: string | null;
  lastUsedAt: string | null;
  loadCount: number;
  useCount: number;
  qualityScore: number;
  /** 最近 N 次使用的质量评分，用于检测下降趋势 */
  recentQualityScores: number[];
}

interface SkillUsageData {
  skills: Record<string, SkillUsageRecord>;
  lastScanAt: string;
}

const USAGE_FILE = path.resolve(process.cwd(), 'data', 'evolution', 'skill-usage.json');
const STALE_AFTER_DAYS = 30;

export class SkillUsageTracker {
  private data: SkillUsageData;

  constructor() {
    this.data = this.load();
  }

  private load(): SkillUsageData {
    try {
      if (fs.existsSync(USAGE_FILE)) {
        return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
      }
    } catch {
      // 静默失败
    }
    return { skills: {}, lastScanAt: new Date().toISOString() };
  }

  private save(): void {
    try {
      const dir = path.dirname(USAGE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.data.lastScanAt = new Date().toISOString();
      fs.writeFileSync(USAGE_FILE, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      Logger.warn(`SkillUsageTracker 持久化失败: ${(err as Error).message}`, 'SkillUsageTracker');
    }
  }

  /**
   * 注册一个新 skill（由 EvolutionEngine.generateSkill 调用）
   */
  register(name: string, skillPath: string, qualityScore: number = 0.7): void {
    if (this.data.skills[name]) return; // 已存在
    this.data.skills[name] = {
      name,
      path: skillPath,
      createdAt: new Date().toISOString(),
      lastLoadedAt: null,
      lastUsedAt: null,
      loadCount: 0,
      useCount: 0,
      qualityScore,
      recentQualityScores: [],
    };
    this.save();
    Logger.info(`📋 Skill 注册到追踪器: ${name}`, 'SkillUsageTracker');
  }

  /**
   * skill 被加载/查看
   */
  trackLoad(name: string): void {
    const record = this.data.skills[name];
    if (!record) return;
    record.lastLoadedAt = new Date().toISOString();
    record.loadCount++;
    this.save();
  }

  /**
   * skill 被实际用于任务
   */
  trackUse(name: string, qualityScore?: number): void {
    const record = this.data.skills[name];
    if (!record) return;
    record.lastUsedAt = new Date().toISOString();
    record.useCount++;
    if (qualityScore !== undefined) {
      // 移动平均更新 qualityScore
      record.qualityScore = (record.qualityScore * (record.useCount - 1) + qualityScore) / record.useCount;
      // 维护最近质量评分队列（最多保留10条）
      record.recentQualityScores = record.recentQualityScores || [];
      record.recentQualityScores.push(qualityScore);
      if (record.recentQualityScores.length > 10) {
        record.recentQualityScores = record.recentQualityScores.slice(-10);
      }
    }
    this.save();
  }

  /**
   * 获取所有已注册 skill 的统计
   */
  getStats(): SkillUsageRecord[] {
    return Object.values(this.data.skills).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * 获取不常用的 skill（30天未使用或从未使用）
   */
  getLeastUsed(): SkillUsageRecord[] {
    const now = Date.now();
    const staleThreshold = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    return Object.values(this.data.skills).filter((s) => {
      if (s.useCount === 0) return true;
      if (!s.lastUsedAt) return true;
      return now - new Date(s.lastUsedAt).getTime() > staleThreshold;
    });
  }

  /**
   * 获取活跃的 skill（最近30天使用过的）
   */
  getActive(): SkillUsageRecord[] {
    const now = Date.now();
    const activeThreshold = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    return Object.values(this.data.skills).filter((s) => {
      if (!s.lastUsedAt) return false;
      return now - new Date(s.lastUsedAt).getTime() <= activeThreshold;
    });
  }

  /**
   * 扫描目录，注册新发现的 skill 文件
   */
  scanDirectory(skillsDir: string): number {
    if (!fs.existsSync(skillsDir)) return 0;
    const files = fs.readdirSync(skillsDir).filter(f => f.endsWith('.md'));
    let newCount = 0;
    for (const file of files) {
      const name = file.replace(/\.md$/, '');
      if (!this.data.skills[name]) {
        this.register(name, path.join(skillsDir, file));
        newCount++;
      }
    }
    return newCount;
  }

  /**
   * 统计数据摘要
   */
  getSummary(): { total: number; active: number; stale: number } {
    const all = Object.values(this.data.skills);
    const now = Date.now();
    const staleThreshold = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
    return {
      total: all.length,
      active: all.filter(s => s.lastUsedAt && (now - new Date(s.lastUsedAt).getTime()) <= staleThreshold).length,
      stale: all.filter(s => !s.lastUsedAt || (now - new Date(s.lastUsedAt).getTime()) > staleThreshold).length,
    };
  }

  /**
   * 获取指定 skill 的记录
   * @param name - skill 名称
   * @returns skill 使用记录，不存在则返回 undefined
   */
  getRecord(name: string): SkillUsageRecord | undefined {
    return this.data.skills[name];
  }

  /**
   * 获取指定 skill 的最近质量评分
   * @param name - skill 名称
   * @returns 最近的质量评分数组，不存在则返回空数组
   */
  getRecentQualityScores(name: string): number[] {
    const record = this.data.skills[name];
    if (!record || !record.recentQualityScores) return [];
    return [...record.recentQualityScores];
  }

  /**
   * 获取所有已注册的 auto-generated skill 名称
   * @returns skill 名称数组
   */
  getAutoGeneratedSkillNames(): string[] {
    return Object.keys(this.data.skills).filter(name => name.startsWith('auto-'));
  }
}

/** 全局单例 */
export const skillUsageTracker = new SkillUsageTracker();
