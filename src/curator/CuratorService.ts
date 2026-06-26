/**
 * CuratorService — 技能库后台维护服务
 *
 * 职责：
 * 1. 使用遥测：跟踪技能的查看、使用、修补频率
 * 2. 状态转换：active → stale → archived（确定性，无 LLM）
 * 3. 固定技能：保护技能不被自动归档或删除
 * 4. 备份/回滚：每次变更前创建快照，支持一键回滚
 * 5. 运行报告：每次运行生成可审计的报告
 *
 * 触发方式：由 AutonomousTrigger 在空闲时调用，或通过 CLI/API 手动触发
 *
 * 数据持久化：
 * - data/curator/usage.json  — 使用遥测
 * - data/curator/state.json  — 运行状态（last_run_at, paused 等）
 * - data/curator/backups/    — 备份快照
 * - data/curator/logs/       — 运行报告
 * - data/skills/.archive/    — 归档技能
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { SkillState, SkillUsageEntry } from '../skills/SkillInterface';
import { SkillRegistry } from '../skills/SkillRegistry';
import { Logger } from '../utils/Logger';

/**
 * 技能洞察报告 — Agent 之间共享技能使用模式的数据结构
 * （从 SkillUsageTracker 迁移）
 */
export interface SkillInsightReport {
  /** 生成报告的 Agent 标识 */
  agentId: string;
  /** 使用频率最高的技能及其成功率 */
  topSkills: Array<{
    name: string;
    usageCount: number;
    successRate: number;
  }>;
  /** 基于使用模式的建议 */
  recommendations: string[];
  /** 报告生成时间 ISO 字符串 */
  generatedAt: string;
}

const MAX_QUALITY_SCORES_HISTORY = 100;

// ─── 配置接口 ───────────────────────────────────────────────

export interface CuratorConfig {
  /** 是否启用 Curator */
  enabled: boolean;
  /** 运行间隔（小时），默认 168（7天） */
  interval_hours: number;
  /** 最小空闲时间（小时），默认 2 */
  min_idle_hours: number;
  /** 技能变为 stale 的天数，默认 30 */
  stale_after_days: number;
  /** 技能被归档的天数，默认 90 */
  archive_after_days: number;
  /** 是否允许归档捆绑内置技能，默认 true */
  prune_builtins: boolean;
  /** 备份配置 */
  backup: {
    enabled: boolean;
    keep: number;
  };
}

const DEFAULT_CONFIG: CuratorConfig = {
  enabled: true,
  interval_hours: 168,
  min_idle_hours: 2,
  stale_after_days: 30,
  archive_after_days: 90,
  prune_builtins: true,
  backup: {
    enabled: true,
    keep: 5,
  },
};

// ─── 运行状态 ───────────────────────────────────────────────

interface CuratorState {
  /** 上次运行时间 ISO */
  last_run_at: string | null;
  /** 是否暂停 */
  paused: boolean;
  /** 首次运行标记（首次观测只记录时间，不执行） */
  first_observation: boolean;
}

// ─── 使用遥测数据 ───────────────────────────────────────────

interface UsageData {
  [skillName: string]: SkillUsageEntry;
}

// ─── 备份清单 ───────────────────────────────────────────────

interface BackupManifest {
  id: string;
  created_at: string;
  reason: string;
  size_bytes: number;
  skill_count: number;
}

// ─── 运行报告 ───────────────────────────────────────────────

export interface CuratorRunReport {
  /** 运行 ID（时间戳格式） */
  run_id: string;
  /** 运行开始时间 */
  started_at: string;
  /** 运行结束时间 */
  finished_at: string | null;
  /** 是否为 dry-run */
  dry_run: boolean;
  /** 状态转换记录 */
  transitions: Array<{
    skill: string;
    from: SkillState;
    to: SkillState;
    reason: string;
  }>;
  /** 固定技能列表 */
  pinned_skills: string[];
  /** 统计摘要 */
  summary: {
    total_skills: number;
    active: number;
    stale: number;
    archived: number;
    pinned: number;
  };
  /** LRU Top 5（最久未使用） */
  lru_top5: Array<{ name: string; last_used_at: string | null }>;
  /** 重命名映射（合并时使用） */
  rename_mapping: Array<{ from: string; to: string }>;
  /** 错误列表 */
  errors: Array<{ skill: string; error: string }>;
}

// ─── CuratorService ─────────────────────────────────────────

export class CuratorService {
  private static instance: CuratorService | null = null;
  private config: CuratorConfig;
  private dataDir: string;
  private usageData: UsageData;
  private state: CuratorState;
  private skillRegistry: SkillRegistry;

  private constructor(config?: Partial<CuratorConfig>, dataDir?: string) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dataDir = dataDir || path.resolve(process.cwd(), 'data', 'curator');
    this.skillRegistry = SkillRegistry.getInstance();
    this.usageData = this.loadUsage();
    this.state = this.loadState();
  }

  public static getInstance(
    config?: Partial<CuratorConfig>,
    dataDir?: string
  ): CuratorService {
    if (!CuratorService.instance) {
      CuratorService.instance = new CuratorService(config, dataDir);
    }
    return CuratorService.instance;
  }

  public static reset(): void {
    CuratorService.instance = null;
  }

  // ─── 配置 ──────────────────────────────────────────────

  /** 获取当前配置 */
  public getConfig(): CuratorConfig {
    return { ...this.config };
  }

  /** 更新配置 */
  public updateConfig(updates: Partial<CuratorConfig>): void {
    this.config = { ...this.config, ...updates };
    Logger.info('Curator 配置已更新', 'CuratorService');
  }

  // ─── 使用遥测 ──────────────────────────────────────────

  /**
   * 记录技能查看
   * @param skillName - 技能名称
   */
  public trackView(skillName: string): void {
    if (this.isBundledOrHub(skillName)) return;
    const entry = this.getOrCreateEntry(skillName);
    entry.view_count++;
    entry.last_viewed_at = new Date().toISOString();
    this.saveUsage();
  }

  /**
   * 记录技能使用
   * @param skillName - 技能名称
   */
  public trackUse(skillName: string): void {
    if (this.isBundledOrHub(skillName)) return;
    const entry = this.getOrCreateEntry(skillName);
    entry.use_count++;
    entry.last_used_at = new Date().toISOString();
    this.saveUsage();
  }

  /**
   * 记录技能修补
   * @param skillName - 技能名称
   */
  public trackPatch(skillName: string): void {
    if (this.isBundledOrHub(skillName)) return;
    const entry = this.getOrCreateEntry(skillName);
    entry.patch_count++;
    entry.last_patched_at = new Date().toISOString();
    this.saveUsage();
  }

  /**
   * 获取技能使用遥测
   * @param skillName - 技能名称
   */
  public getUsage(skillName: string): SkillUsageEntry | undefined {
    return this.usageData[skillName];
  }

  /**
   * 获取所有使用遥测
   */
  public getAllUsage(): UsageData {
    return { ...this.usageData };
  }

  // ─── 固定技能 ──────────────────────────────────────────

  /**
   * 固定技能（保护不被自动归档）
   * @param skillName - 技能名称
   * @returns 是否成功
   */
  public pin(skillName: string): { success: boolean; error?: string } {
    if (this.isBundledOrHub(skillName)) {
      return {
        success: false,
        error: '捆绑和 hub 安装的技能本就不受 Curator 变更，无需固定',
      };
    }
    const entry = this.getOrCreateEntry(skillName);
    if (entry.pinned) {
      return { success: false, error: `技能 ${skillName} 已被固定` };
    }
    entry.pinned = true;
    this.saveUsage();
    Logger.info(`📌 技能已固定: ${skillName}`, 'CuratorService');
    return { success: true };
  }

  /**
   * 取消固定技能
   * @param skillName - 技能名称
   * @returns 是否成功
   */
  public unpin(skillName: string): { success: boolean; error?: string } {
    const entry = this.usageData[skillName];
    if (!entry || !entry.pinned) {
      return { success: false, error: `技能 ${skillName} 未被固定` };
    }
    entry.pinned = false;
    this.saveUsage();
    Logger.info(`📌 技能已取消固定: ${skillName}`, 'CuratorService');
    return { success: true };
  }

  /**
   * 获取所有固定技能列表
   */
  public getPinnedSkills(): string[] {
    return Object.entries(this.usageData)
      .filter(([, entry]) => entry.pinned)
      .map(([name]) => name);
  }

  // ─── SkillUsageTracker 兼容方法 ─────────────────────────

  /**
   * 注册技能到追踪器（兼容 SkillUsageTracker.register）
   * @param name - 技能名称
   * @param skillPath - 技能文件路径
   * @param qualityScore - 初始质量评分
   */
  public register(
    name: string,
    skillPath: string,
    qualityScore: number = 0.7
  ): void {
    const entry = this.getOrCreateEntry(name);
    if (entry.skill_path) return; // 已存在
    entry.skill_path = skillPath;
    entry.quality_score = qualityScore;
    this.saveUsage();
    Logger.info(`📋 技能注册到追踪器: ${name}`, 'CuratorService');
  }

  /**
   * 追踪技能加载/查看（兼容 SkillUsageTracker.trackLoad）
   */
  public trackLoad(name: string): void {
    this.trackView(name);
  }

  /**
   * 追踪技能使用并更新质量评分（兼容 SkillUsageTracker.trackUse）
   * @param name - 技能名称
   * @param qualityScore - 可选质量评分
   */
  public trackUseWithQuality(name: string, qualityScore?: number): void {
    if (this.isBundledOrHub(name)) return;
    const entry = this.getOrCreateEntry(name);
    entry.use_count++;
    entry.last_used_at = new Date().toISOString();
    if (qualityScore !== undefined) {
      entry.quality_score =
        (entry.quality_score * (entry.use_count - 1) + qualityScore) /
        entry.use_count;
      entry.recent_quality_scores = entry.recent_quality_scores || [];
      entry.recent_quality_scores.push(qualityScore);
      if (entry.recent_quality_scores.length > MAX_QUALITY_SCORES_HISTORY) {
        entry.recent_quality_scores = entry.recent_quality_scores.slice(
          -MAX_QUALITY_SCORES_HISTORY
        );
      }
    }
    this.saveUsage();
  }

  /**
   * 获取技能使用记录（兼容 SkillUsageTracker.getRecord）
   */
  public getRecord(name: string): SkillUsageEntry | undefined {
    return this.usageData[name];
  }

  /**
   * 获取最近质量评分（兼容 SkillUsageTracker.getRecentQualityScores）
   */
  public getRecentQualityScores(name: string): number[] {
    const record = this.usageData[name];
    if (!record || !record.recent_quality_scores) return [];
    return [...record.recent_quality_scores];
  }

  /**
   * 获取所有自动生成技能名称（兼容 SkillUsageTracker.getAutoGeneratedSkillNames）
   */
  public getAutoGeneratedSkillNames(): string[] {
    return Object.keys(this.usageData).filter((name) =>
      name.startsWith('auto-')
    );
  }

  /**
   * 获取不常用技能（兼容 SkillUsageTracker.getLeastUsed）
   */
  public getLeastUsed(): SkillUsageEntry[] {
    const now = Date.now();
    const staleThreshold = this.config.stale_after_days * 24 * 60 * 60 * 1000;
    return Object.values(this.usageData).filter((s) => {
      if (s.use_count === 0) return true;
      if (!s.last_used_at) return true;
      return now - new Date(s.last_used_at).getTime() > staleThreshold;
    });
  }

  /**
   * 获取活跃技能（兼容 SkillUsageTracker.getActive）
   */
  public getActiveSkills(): SkillUsageEntry[] {
    const now = Date.now();
    const activeThreshold = this.config.stale_after_days * 24 * 60 * 60 * 1000;
    return Object.values(this.usageData).filter((s) => {
      if (!s.last_used_at) return false;
      return now - new Date(s.last_used_at).getTime() <= activeThreshold;
    });
  }

  /**
   * 获取统计数据摘要（兼容 SkillUsageTracker.getSummary）
   */
  public getSummary(): { total: number; active: number; stale: number } {
    const all = Object.values(this.usageData);
    const now = Date.now();
    const staleThreshold = this.config.stale_after_days * 24 * 60 * 60 * 1000;
    return {
      total: all.length,
      active: all.filter(
        (s) =>
          s.last_used_at &&
          now - new Date(s.last_used_at).getTime() <= staleThreshold
      ).length,
      stale: all.filter(
        (s) =>
          !s.last_used_at ||
          now - new Date(s.last_used_at).getTime() > staleThreshold
      ).length,
    };
  }

  /**
   * 扫描目录注册新技能（兼容 SkillUsageTracker.scanDirectory）
   */
  public scanDirectory(skillsDir: string): number {
    if (!fs.existsSync(skillsDir)) return 0;
    const files = fs.readdirSync(skillsDir).filter((f) => f.endsWith('.md'));
    let newCount = 0;
    for (const file of files) {
      const name = file.replace(/\.md$/, '');
      if (!this.usageData[name]) {
        this.register(name, path.join(skillsDir, file));
        newCount++;
      }
    }
    return newCount;
  }

  /**
   * 生成技能使用洞察报告（兼容 SkillUsageTracker.shareSkillInsights）
   */
  public shareSkillInsights(agentId: string): SkillInsightReport {
    const allSkills = Object.values(this.usageData);

    const topSkills = allSkills
      .filter((s) => s.use_count > 0)
      .sort((a, b) => b.use_count - a.use_count)
      .slice(0, 10)
      .map((s) => ({
        name: s.name,
        usageCount: s.use_count,
        successRate: s.quality_score,
      }));

    const recommendations: string[] = [];

    // 建议优化低质量高频技能
    const lowQualityHighUse = topSkills.filter(
      (s) => s.successRate < 0.5 && s.usageCount > 3
    );
    for (const skill of lowQualityHighUse) {
      recommendations.push(
        `技能 "${skill.name}" 使用频繁但成功率较低(${(skill.successRate * 100).toFixed(0)}%)，建议优化`
      );
    }

    // 建议清理陈旧技能
    const staleSkills = this.getLeastUsed();
    if (staleSkills.length > 5) {
      recommendations.push(
        `有 ${staleSkills.length} 个不常用技能，建议评估是否需要保留`
      );
    }

    const report: SkillInsightReport = {
      agentId,
      topSkills,
      recommendations,
      generatedAt: new Date().toISOString(),
    };

    Logger.info(
      `📊 技能洞察报告已生成: agent=${agentId}, topSkills=${topSkills.length}`,
      'CuratorService'
    );

    return report;
  }

  /**
   * 整合外部洞察（兼容 SkillUsageTracker.integrateExternalInsights）
   */
  public integrateExternalInsights(insights: SkillInsightReport): number {
    if (!insights.agentId || !insights.generatedAt) return 0;

    let integratedCount = 0;
    for (const externalSkill of insights.topSkills) {
      const localRecord = this.usageData[externalSkill.name];
      if (localRecord) {
        const adjustedScore =
          localRecord.quality_score * 0.8 + externalSkill.successRate * 0.2;
        localRecord.quality_score = Math.round(adjustedScore * 1000) / 1000;
        integratedCount++;
      }
    }

    for (const rec of insights.recommendations) {
      Logger.info(
        `💡 外部建议(from ${insights.agentId}): ${rec}`,
        'CuratorService'
      );
    }

    this.saveUsage();
    return integratedCount;
  }

  // ─── 状态转换（确定性，无 LLM）────────────────────────

  /**
   * 执行自动状态转换
   * @param dryRun - 是否为预览模式（不实际修改）
   * @returns 状态转换记录
   */
  public performTransitions(dryRun: boolean = false): Array<{
    skill: string;
    from: SkillState;
    to: SkillState;
    reason: string;
  }> {
    const transitions: Array<{
      skill: string;
      from: SkillState;
      to: SkillState;
      reason: string;
    }> = [];
    const now = Date.now();
    const staleThreshold = this.config.stale_after_days * 24 * 60 * 60 * 1000;
    const archiveThreshold =
      this.config.archive_after_days * 24 * 60 * 60 * 1000;

    for (const [name, entry] of Object.entries(this.usageData)) {
      // 跳过固定技能
      if (entry.pinned) continue;
      // 跳过已归档技能
      if (entry.state === 'archived') continue;
      // 跳过捆绑/hub 技能（如果不允许 prune_builtins）
      if (!this.config.prune_builtins && this.isBundledOrHub(name)) continue;

      const lastUsed = entry.last_used_at
        ? new Date(entry.last_used_at).getTime()
        : new Date(entry.created_at).getTime();
      const daysSinceUse = now - lastUsed;

      if (daysSinceUse > archiveThreshold && entry.state === 'stale') {
        // stale → archived
        transitions.push({
          skill: name,
          from: 'stale',
          to: 'archived',
          reason: `${this.config.archive_after_days} 天未使用`,
        });
        if (!dryRun) {
          entry.state = 'archived';
          entry.archived_at = new Date().toISOString();
          this.archiveSkillFiles(name);
        }
      } else if (daysSinceUse > staleThreshold && entry.state === 'active') {
        // active → stale
        transitions.push({
          skill: name,
          from: 'active',
          to: 'stale',
          reason: `${this.config.stale_after_days} 天未使用`,
        });
        if (!dryRun) {
          entry.state = 'stale';
        }
      }
    }

    if (!dryRun && transitions.length > 0) {
      this.saveUsage();
    }

    return transitions;
  }

  // ─── LLM 审查 pass ────────────────────────────────────

  /**
   * 执行 LLM 审查 pass：检测近似重复技能并合并
   *
   * 策略：
   * 1. 收集所有 agent 创建的技能名称和描述
   * 2. 基于名称相似度和描述重叠检测候选重复项
   * 3. 对候选对进行合并决策
   * 4. 执行合并（将次要技能归档，保留主要技能）
   *
   * 注意：此方法不直接调用 LLM API（避免依赖特定模型），
   * 而是使用确定性相似度算法。如果配置了辅助模型，
   * 可通过 performLLMReviewWithModel 方法增强。
   *
   * @param dryRun - 是否为预览模式
   * @returns 审查结果
   */
  public async performLLMReview(dryRun: boolean = false): Promise<{
    rename_mapping: Array<{ from: string; to: string }>;
    transitions: Array<{
      skill: string;
      from: SkillState;
      to: SkillState;
      reason: string;
    }>;
    errors: Array<{ skill: string; error: string }>;
  }> {
    const result = {
      rename_mapping: [] as Array<{ from: string; to: string }>,
      transitions: [] as Array<{
        skill: string;
        from: SkillState;
        to: SkillState;
        reason: string;
      }>,
      errors: [] as Array<{ skill: string; error: string }>,
    };

    // 收集所有 agent 创建的技能（非捆绑/hub）
    const agentSkills = Object.entries(this.usageData).filter(
      ([, entry]) =>
        entry.state !== 'archived' &&
        !entry.pinned &&
        !this.isBundledOrHub(entry.name)
    );

    if (agentSkills.length < 2) return result;

    // 检测近似重复项
    const duplicates = this.detectDuplicateSkills(agentSkills);

    for (const group of duplicates) {
      if (group.length < 2) continue;

      // 选择保留哪个：使用次数最多的作为主技能
      const sorted = group.sort((a, b) => b.use_count - a.use_count);
      const primary = sorted[0];
      const secondary = sorted.slice(1);

      for (const sec of secondary) {
        result.rename_mapping.push({
          from: sec.name,
          to: primary.name,
        });

        if (!dryRun) {
          // 将次要技能归档
          sec.state = 'archived';
          sec.archived_at = new Date().toISOString();
          this.archiveSkillFiles(sec.name);

          // 将次要技能的使用计数合并到主技能
          primary.use_count += sec.use_count;
          primary.view_count += sec.view_count;
          primary.patch_count += sec.patch_count;

          result.transitions.push({
            skill: sec.name,
            from: 'active',
            to: 'archived',
            reason: `与 ${primary.name} 重复，合并到主技能`,
          });
        }
      }
    }

    if (!dryRun && result.rename_mapping.length > 0) {
      this.saveUsage();
    }

    return result;
  }

  /**
   * 检测近似重复技能组
   *
   * 使用三层匹配策略：
   * 1. 名称完全相同（忽略大小写和分隔符）
   * 2. 名称前缀/后缀重叠（如 "code-review" 和 "code-review-python"）
   * 3. 描述关键词重叠度 > 60%
   */
  private detectDuplicateSkills(
    skills: Array<[string, SkillUsageEntry]>
  ): SkillUsageEntry[][] {
    const groups: SkillUsageEntry[][] = [];
    const assigned = new Set<string>();

    for (let i = 0; i < skills.length; i++) {
      const [nameA, entryA] = skills[i];
      if (assigned.has(nameA)) continue;

      const group: SkillUsageEntry[] = [entryA];
      assigned.add(nameA);

      for (let j = i + 1; j < skills.length; j++) {
        const [nameB, entryB] = skills[j];
        if (assigned.has(nameB)) continue;

        if (this.areSkillsSimilar(nameA, entryA, nameB, entryB)) {
          group.push(entryB);
          assigned.add(nameB);
        }
      }

      if (group.length >= 2) {
        groups.push(group);
      }
    }

    return groups;
  }

  /**
   * 判断两个技能是否相似
   */
  private areSkillsSimilar(
    nameA: string,
    _entryA: SkillUsageEntry,
    nameB: string,
    _entryB: SkillUsageEntry
  ): boolean {
    // 层1：名称标准化后完全相同
    const normA = this.normalizeSkillName(nameA);
    const normB = this.normalizeSkillName(nameB);
    if (normA === normB) return true;

    // 层2：一个名称是另一个的前缀
    if (normA.startsWith(normB) || normB.startsWith(normA)) {
      // 前缀匹配要求前缀至少3个字符
      const shorter = normA.length < normB.length ? normA : normB;
      if (shorter.length >= 3) return true;
    }

    // 层3：描述关键词重叠度
    const skillA = this.skillRegistry.getSkill(nameA);
    const skillB = this.skillRegistry.getSkill(nameB);
    if (skillA && skillB) {
      const overlap = this.computeDescriptionOverlap(
        skillA.definition.description,
        skillB.definition.description
      );
      if (overlap > 0.6) return true;
    }

    return false;
  }

  /**
   * 标准化技能名称（去除分隔符、转小写）
   */
  private normalizeSkillName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[-_\s]+/g, '')
      .replace(/^auto-/, '');
  }

  /**
   * 计算两个描述的关键词重叠度
   */
  private computeDescriptionOverlap(descA: string, descB: string): number {
    const wordsA = new Set(
      descA
        .toLowerCase()
        .split(/[\s,，。.、；;：:！!？?]+/)
        .filter((w) => w.length >= 2)
    );
    const wordsB = new Set(
      descB
        .toLowerCase()
        .split(/[\s,，。.、；;：:！!？?]+/)
        .filter((w) => w.length >= 2)
    );

    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let intersection = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) intersection++;
    }

    const union = new Set([...wordsA, ...wordsB]).size;
    return union > 0 ? intersection / union : 0;
  }

  // ─── 恢复已归档技能 ────────────────────────────────────

  /**
   * 恢复已归档的技能
   * @param skillName - 技能名称
   * @returns 是否成功
   */
  public restore(skillName: string): { success: boolean; error?: string } {
    const entry = this.usageData[skillName];
    if (!entry || entry.state !== 'archived') {
      return { success: false, error: `技能 ${skillName} 未被归档` };
    }

    // 检查是否有同名捆绑/hub 技能会遮蔽
    if (this.isBundledOrHub(skillName)) {
      return {
        success: false,
        error: `存在同名的捆绑/hub 技能，恢复会被遮蔽`,
      };
    }

    // 从归档目录移回
    const restored = this.restoreSkillFiles(skillName);
    if (!restored) {
      return {
        success: false,
        error: `归档文件不存在或恢复失败: ${skillName}`,
      };
    }

    entry.state = 'active';
    entry.archived_at = null;
    this.saveUsage();
    Logger.info(`📦 技能已恢复: ${skillName}`, 'CuratorService');
    return { success: true };
  }

  // ─── 完整运行 ──────────────────────────────────────────

  /**
   * 执行一次完整的 Curator 运行
   * @param dryRun - 是否为预览模式
   * @returns 运行报告
   */
  public async run(dryRun: boolean = false): Promise<CuratorRunReport> {
    const runId = this.generateRunId();
    const report: CuratorRunReport = {
      run_id: runId,
      started_at: new Date().toISOString(),
      finished_at: null,
      dry_run: dryRun,
      transitions: [],
      pinned_skills: this.getPinnedSkills(),
      summary: { total_skills: 0, active: 0, stale: 0, archived: 0, pinned: 0 },
      lru_top5: [],
      rename_mapping: [],
      errors: [],
    };

    Logger.info(
      `Curator 运行开始: ${runId}${dryRun ? ' (dry-run)' : ''}`,
      'CuratorService'
    );

    try {
      // 首次运行只记录时间
      if (this.state.first_observation) {
        if (!dryRun) {
          this.state.first_observation = false;
          this.state.last_run_at = new Date().toISOString();
          this.saveState();
        }
        Logger.info(
          'Curator 首次观测，记录时间，推迟到下一个间隔运行',
          'CuratorService'
        );
        report.finished_at = new Date().toISOString();
        return report;
      }

      // 备份（非 dry-run 时）
      if (!dryRun && this.config.backup.enabled) {
        await this.createBackup(`pre-run ${runId}`);
      }

      // 同步技能注册表中的技能到遥测
      this.syncSkillRegistry();

      // 执行状态转换
      report.transitions = this.performTransitions(dryRun);

      // LLM 审查 pass：检测近似重复技能并合并
      const llmResult = await this.performLLMReview(dryRun);
      if (llmResult.rename_mapping.length > 0) {
        report.rename_mapping = llmResult.rename_mapping;
      }
      if (llmResult.errors.length > 0) {
        report.errors.push(...llmResult.errors);
      }
      // LLM 审查可能产生额外的状态转换
      if (llmResult.transitions.length > 0) {
        report.transitions.push(...llmResult.transitions);
      }

      // 计算统计
      this.computeSummary(report);

      // 计算 LRU Top 5
      report.lru_top5 = this.getLRUTop5();

      // 更新运行状态
      if (!dryRun) {
        this.state.last_run_at = new Date().toISOString();
        this.saveState();
      }

      report.finished_at = new Date().toISOString();

      // 写入运行报告
      this.writeRunReport(runId, report);

      Logger.info(
        `Curator 运行完成: ${runId}, transitions=${report.transitions.length}`,
        'CuratorService'
      );
    } catch (error) {
      Logger.error('Curator 运行失败', error as Error, 'CuratorService');
      report.errors.push({
        skill: '__global__',
        error: (error as Error).message,
      });
      report.finished_at = new Date().toISOString();
    }

    return report;
  }

  // ─── 状态查询 ──────────────────────────────────────────

  /**
   * 获取 Curator 状态概览
   */
  public getStatus(): {
    enabled: boolean;
    paused: boolean;
    last_run_at: string | null;
    next_run_eligible: string;
    config: CuratorConfig;
    counts: { active: number; stale: number; archived: number; pinned: number };
    lru_top5: Array<{ name: string; last_used_at: string | null }>;
    pinned_list: string[];
  } {
    const counts = { active: 0, stale: 0, archived: 0, pinned: 0 };
    for (const entry of Object.values(this.usageData)) {
      counts[entry.state as keyof typeof counts]++;
      if (entry.pinned) counts.pinned++;
    }

    const nextEligible = this.state.last_run_at
      ? new Date(
          new Date(this.state.last_run_at).getTime() +
            this.config.interval_hours * 60 * 60 * 1000
        ).toISOString()
      : '首次观测后一个间隔';

    return {
      enabled: this.config.enabled,
      paused: this.state.paused,
      last_run_at: this.state.last_run_at,
      next_run_eligible: nextEligible,
      config: this.getConfig(),
      counts,
      lru_top5: this.getLRUTop5(),
      pinned_list: this.getPinnedSkills(),
    };
  }

  /**
   * 检查是否应该运行 Curator
   * @param lastActivityTime - 最后一次用户活动时间
   */
  public shouldRun(lastActivityTime: number): boolean {
    if (!this.config.enabled) return false;
    if (this.state.paused) return false;

    // 检查间隔
    if (this.state.last_run_at) {
      const elapsed = Date.now() - new Date(this.state.last_run_at).getTime();
      const intervalMs = this.config.interval_hours * 60 * 60 * 1000;
      if (elapsed < intervalMs) return false;
    }

    // 检查空闲
    const idleMs = Date.now() - lastActivityTime;
    const minIdleMs = this.config.min_idle_hours * 60 * 60 * 1000;
    if (idleMs < minIdleMs) return false;

    return true;
  }

  // ─── 暂停/恢复 ─────────────────────────────────────────

  public pause(): void {
    this.state.paused = true;
    this.saveState();
    Logger.info('Curator 已暂停', 'CuratorService');
  }

  public resume(): void {
    this.state.paused = false;
    this.saveState();
    Logger.info('Curator 已恢复', 'CuratorService');
  }

  public isPaused(): boolean {
    return this.state.paused;
  }

  // ─── 备份/回滚 ─────────────────────────────────────────

  /**
   * 创建备份快照
   * @param reason - 备份原因
   */
  public async createBackup(reason: string): Promise<BackupManifest | null> {
    if (!this.config.backup.enabled) {
      Logger.warn('备份已禁用，跳过', 'CuratorService');
      return null;
    }

    const skillsDir = path.resolve(process.cwd(), 'data', 'skills');
    if (!fs.existsSync(skillsDir)) {
      Logger.warn('技能目录不存在，跳过备份', 'CuratorService');
      return null;
    }

    const backupId = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(this.dataDir, 'backups', backupId);

    try {
      fs.mkdirSync(backupDir, { recursive: true });

      // 创建 tar.gz 快照
      const archivePath = path.join(backupDir, 'skills.tar.gz');
      await this.tarGzDirectory(skillsDir, archivePath);

      const stats = fs.statSync(archivePath);
      const skillCount = this.countSkillsInDir(skillsDir);

      const manifest: BackupManifest = {
        id: backupId,
        created_at: new Date().toISOString(),
        reason,
        size_bytes: stats.size,
        skill_count: skillCount,
      };

      fs.writeFileSync(
        path.join(backupDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf-8'
      );

      // 裁剪旧备份
      this.pruneBackups();

      Logger.info(
        `备份已创建: ${backupId} (${(stats.size / 1024).toFixed(1)}KB)`,
        'CuratorService'
      );
      return manifest;
    } catch (error) {
      Logger.error('备份创建失败', error as Error, 'CuratorService');
      return null;
    }
  }

  /**
   * 列出可用备份
   */
  public listBackups(): BackupManifest[] {
    const backupsDir = path.join(this.dataDir, 'backups');
    if (!fs.existsSync(backupsDir)) return [];

    const manifests: BackupManifest[] = [];
    for (const entry of fs.readdirSync(backupsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = path.join(backupsDir, entry.name, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const data = JSON.parse(
            fs.readFileSync(manifestPath, 'utf-8')
          ) as BackupManifest;
          manifests.push(data);
        } catch {
          // 跳过无效清单
        }
      }
    }

    return manifests.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }

  /**
   * 回滚到指定备份
   * @param backupId - 备份 ID，不提供则使用最新
   */
  public async rollback(
    backupId?: string
  ): Promise<{ success: boolean; error?: string }> {
    const backups = this.listBackups();
    if (backups.length === 0) {
      return { success: false, error: '没有可用的备份' };
    }

    const target = backupId
      ? backups.find((b) => b.id === backupId)
      : backups[0];

    if (!target) {
      return { success: false, error: `备份不存在: ${backupId}` };
    }

    const skillsDir = path.resolve(process.cwd(), 'data', 'skills');
    const archivePath = path.join(
      this.dataDir,
      'backups',
      target.id,
      'skills.tar.gz'
    );

    if (!fs.existsSync(archivePath)) {
      return { success: false, error: `备份文件不存在: ${target.id}` };
    }

    try {
      // 回滚前先创建当前状态快照
      await this.createBackup(`pre-rollback to ${target.id}`);

      // 解压覆盖
      await this.extractTarGz(archivePath, path.dirname(skillsDir));

      // 重新加载遥测数据
      this.usageData = this.loadUsage();

      Logger.info(`已回滚到备份: ${target.id}`, 'CuratorService');
      return { success: true };
    } catch (error) {
      Logger.error('回滚失败', error as Error, 'CuratorService');
      return {
        success: false,
        error: `回滚失败: ${(error as Error).message}`,
      };
    }
  }

  // ─── 私有方法 ──────────────────────────────────────────

  private getOrCreateEntry(skillName: string): SkillUsageEntry {
    if (!this.usageData[skillName]) {
      this.usageData[skillName] = {
        name: skillName,
        view_count: 0,
        use_count: 0,
        patch_count: 0,
        last_viewed_at: null,
        last_used_at: null,
        last_patched_at: null,
        created_at: new Date().toISOString(),
        state: 'active',
        pinned: false,
        archived_at: null,
        skill_path: null,
        quality_score: 0,
        recent_quality_scores: [],
      };
    }
    return this.usageData[skillName];
  }

  /**
   * 判断技能是否为捆绑/hub 安装
   */
  private isBundledOrHub(skillName: string): boolean {
    const skill = this.skillRegistry.getSkill(skillName);
    if (!skill) return false;
    const source = skill.definition.source;
    return source === 'builtin' || source === 'hub';
  }

  /**
   * 同步技能注册表中的技能到遥测数据
   */
  private syncSkillRegistry(): void {
    const allSkills = this.skillRegistry.getAllSkills();
    for (const skill of allSkills) {
      const source = skill.definition.source;
      // 只追踪非捆绑/hub技能
      if (source === 'builtin' || source === 'hub') continue;
      this.getOrCreateEntry(skill.definition.name);
    }
    this.saveUsage();
  }

  /**
   * 计算 LRU Top 5（最久未使用）
   */
  private getLRUTop5(): Array<{ name: string; last_used_at: string | null }> {
    const entries = Object.entries(this.usageData)
      .filter(([, e]) => e.state !== 'archived')
      .map(([name, e]) => ({ name, last_used_at: e.last_used_at }))
      .sort((a, b) => {
        if (!a.last_used_at && !b.last_used_at) return 0;
        if (!a.last_used_at) return -1;
        if (!b.last_used_at) return 1;
        return (
          new Date(a.last_used_at).getTime() -
          new Date(b.last_used_at).getTime()
        );
      });
    return entries.slice(0, 5);
  }

  /**
   * 计算统计摘要
   */
  private computeSummary(report: CuratorRunReport): void {
    const counts = { active: 0, stale: 0, archived: 0, pinned: 0 };
    for (const entry of Object.values(this.usageData)) {
      counts[entry.state as keyof typeof counts]++;
      if (entry.pinned) counts.pinned++;
    }
    report.summary = {
      total_skills: Object.keys(this.usageData).length,
      ...counts,
    };
  }

  /**
   * 归档技能文件（移到 .archive/ 目录）
   */
  private archiveSkillFiles(skillName: string): void {
    const skillsDir = path.resolve(process.cwd(), 'data', 'skills');
    const skillPath = path.join(skillsDir, skillName);
    const archiveDir = path.join(skillsDir, '.archive');

    if (!fs.existsSync(skillPath)) return;

    try {
      if (!fs.existsSync(archiveDir)) {
        fs.mkdirSync(archiveDir, { recursive: true });
      }
      const destPath = path.join(archiveDir, skillName);
      fs.renameSync(skillPath, destPath);
      Logger.info(`技能文件已归档: ${skillName} → .archive/`, 'CuratorService');
    } catch (error) {
      Logger.error(
        `归档技能文件失败: ${skillName}`,
        error as Error,
        'CuratorService'
      );
    }
  }

  /**
   * 恢复已归档的技能文件
   */
  private restoreSkillFiles(skillName: string): boolean {
    const skillsDir = path.resolve(process.cwd(), 'data', 'skills');
    const archivePath = path.join(skillsDir, '.archive', skillName);
    const activePath = path.join(skillsDir, skillName);

    if (!fs.existsSync(archivePath)) return false;

    try {
      fs.renameSync(archivePath, activePath);
      Logger.info(`技能文件已恢复: ${skillName} ← .archive/`, 'CuratorService');
      return true;
    } catch (error) {
      Logger.error(
        `恢复技能文件失败: ${skillName}`,
        error as Error,
        'CuratorService'
      );
      return false;
    }
  }

  /**
   * 生成运行 ID
   */
  private generateRunId(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  }

  /**
   * 写入运行报告
   */
  private writeRunReport(runId: string, report: CuratorRunReport): void {
    const logsDir = path.join(this.dataDir, 'logs', runId);
    try {
      fs.mkdirSync(logsDir, { recursive: true });

      // 机器可读 JSON
      fs.writeFileSync(
        path.join(logsDir, 'run.json'),
        JSON.stringify(report, null, 2),
        'utf-8'
      );

      // 人类可读 Markdown 报告
      const md = this.generateReportMarkdown(report);
      fs.writeFileSync(path.join(logsDir, 'REPORT.md'), md, 'utf-8');
    } catch (error) {
      Logger.error('写入运行报告失败', error as Error, 'CuratorService');
    }
  }

  /**
   * 生成 Markdown 格式报告
   */
  private generateReportMarkdown(report: CuratorRunReport): string {
    const lines: string[] = [
      `# Curator 运行报告`,
      ``,
      `- **运行 ID**: ${report.run_id}`,
      `- **开始时间**: ${report.started_at}`,
      `- **结束时间**: ${report.finished_at || '进行中'}`,
      `- **模式**: ${report.dry_run ? '预览 (dry-run)' : '正式'}`,
      ``,
      `## 统计摘要`,
      ``,
      `| 指标 | 数值 |`,
      `|------|------|`,
      `| 总技能数 | ${report.summary.total_skills} |`,
      `| 活跃 | ${report.summary.active} |`,
      `| 陈旧 | ${report.summary.stale} |`,
      `| 已归档 | ${report.summary.archived} |`,
      `| 已固定 | ${report.summary.pinned} |`,
      ``,
    ];

    if (report.transitions.length > 0) {
      lines.push(`## 状态转换`, ``);
      for (const t of report.transitions) {
        lines.push(`- **${t.skill}**: ${t.from} → ${t.to} (${t.reason})`);
      }
      lines.push(``);
    }

    if (report.lru_top5.length > 0) {
      lines.push(`## 最久未使用 (LRU Top 5)`, ``);
      for (const item of report.lru_top5) {
        lines.push(`- ${item.name}: ${item.last_used_at || '从未使用'}`);
      }
      lines.push(``);
    }

    if (report.rename_mapping.length > 0) {
      lines.push(`## 重命名映射`, ``);
      for (const m of report.rename_mapping) {
        lines.push(`- ${m.from} → ${m.to}`);
      }
      lines.push(``);
    }

    if (report.pinned_skills.length > 0) {
      lines.push(`## 固定技能`, ``);
      for (const name of report.pinned_skills) {
        lines.push(`- ${name}`);
      }
      lines.push(``);
    }

    if (report.errors.length > 0) {
      lines.push(`## 错误`, ``);
      for (const e of report.errors) {
        lines.push(`- **${e.skill}**: ${e.error}`);
      }
      lines.push(``);
    }

    return lines.join('\n');
  }

  /**
   * 创建目录的 tar.gz 压缩
   */
  private async tarGzDirectory(
    sourceDir: string,
    outputPath: string
  ): Promise<void> {
    // 简化实现：递归读取目录，创建 JSON 索引 + 压缩
    const files: Array<{ relativePath: string; content: Buffer }> = [];
    this.collectFiles(sourceDir, sourceDir, files);

    const index = files.map((f) => ({
      path: f.relativePath,
      size: f.content.length,
    }));

    const payload = JSON.stringify({
      version: '1.0.0',
      created_at: new Date().toISOString(),
      index,
      files: files.map((f) => ({
        path: f.relativePath,
        content: f.content.toString('base64'),
      })),
    });

    const compressed = zlib.gzipSync(Buffer.from(payload, 'utf-8'));
    fs.writeFileSync(outputPath, compressed);
  }

  /**
   * 解压 tar.gz 备份
   */
  private async extractTarGz(
    archivePath: string,
    targetDir: string
  ): Promise<void> {
    const compressed = fs.readFileSync(archivePath);
    const decompressed = zlib.gunzipSync(compressed);
    const data = JSON.parse(decompressed.toString('utf-8')) as {
      files: Array<{ path: string; content: string }>;
    };

    const skillsDir = path.join(targetDir, 'skills');
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }

    for (const file of data.files) {
      const filePath = path.join(targetDir, file.path);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, Buffer.from(file.content, 'base64'));
    }
  }

  /**
   * 递归收集目录中的文件
   */
  private collectFiles(
    baseDir: string,
    currentDir: string,
    result: Array<{ relativePath: string; content: Buffer }>
  ): void {
    if (!fs.existsSync(currentDir)) return;

    for (const entry of fs.readdirSync(currentDir, {
      withFileTypes: true,
    })) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // 跳过 .archive 目录（避免递归）
        if (entry.name === '.archive') continue;
        this.collectFiles(baseDir, fullPath, result);
      } else {
        const relativePath = path.relative(baseDir, fullPath);
        result.push({
          relativePath,
          content: fs.readFileSync(fullPath),
        });
      }
    }
  }

  /**
   * 统计目录中的技能数量
   */
  private countSkillsInDir(skillsDir: string): number {
    if (!fs.existsSync(skillsDir)) return 0;
    return fs
      .readdirSync(skillsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.')).length;
  }

  /**
   * 裁剪旧备份，保留最新的 keep 个
   */
  private pruneBackups(): void {
    const backups = this.listBackups();
    const keep = this.config.backup.keep;

    if (backups.length <= keep) return;

    const toRemove = backups.slice(keep);
    for (const backup of toRemove) {
      const backupDir = path.join(this.dataDir, 'backups', backup.id);
      try {
        fs.rmSync(backupDir, { recursive: true, force: true });
        Logger.debug(`旧备份已裁剪: ${backup.id}`, 'CuratorService');
      } catch {
        Logger.warn(`裁剪旧备份失败: ${backup.id}`, 'CuratorService');
      }
    }
  }

  // ─── 持久化 ────────────────────────────────────────────

  private loadUsage(): UsageData {
    const filePath = path.join(this.dataDir, 'usage.json');
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as UsageData;
      }
    } catch (error) {
      Logger.warn(
        `加载使用遥测失败: ${(error as Error).message}`,
        'CuratorService'
      );
    }
    return {};
  }

  private saveUsage(): void {
    const filePath = path.join(this.dataDir, 'usage.json');
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(
        filePath,
        JSON.stringify(this.usageData, null, 2),
        'utf-8'
      );
    } catch (error) {
      Logger.error('保存使用遥测失败', error as Error, 'CuratorService');
    }
  }

  private loadState(): CuratorState {
    const filePath = path.join(this.dataDir, 'state.json');
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CuratorState;
      }
    } catch (error) {
      Logger.warn(
        `加载 Curator 状态失败: ${(error as Error).message}`,
        'CuratorService'
      );
    }
    return {
      last_run_at: null,
      paused: false,
      first_observation: true,
    };
  }

  private saveState(): void {
    const filePath = path.join(this.dataDir, 'state.json');
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(this.state, null, 2), 'utf-8');
    } catch (error) {
      Logger.error('保存 Curator 状态失败', error as Error, 'CuratorService');
    }
  }
}
