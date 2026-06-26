/**
 * ContextFileRegistry - 上下文系统辅助组件
 *
 * 【架构定位】
 * 上下文系统辅助组件，负责项目文件上下文的发现与管理
 *
 * 【核心职责】
 * - 统一上下文文件发现：自动扫描项目中的上下文文件
 * - 优先级管理：按优先级加载上下文文件
 * - 安全扫描：检测 prompt 注入模式
 * - 文件截断：超大文件 70/20/10 截断策略
 * - SOUL.md 独立插槽：与项目上下文分离，始终加载
 *
 * 【在整体架构中的位置】
 * 项目文件 → ContextFileRegistry（本文件）→ ConstitutionPromptBuilder
 *
 * 【使用场景】
 * - 项目级上下文加载
 * - SOUL.md 人格文件加载
 * - 上下文文件安全检查
 *
 * 设计参考 Hermes Agent 上下文文件系统
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../../utils/Logger';

// ==================== 类型定义 ====================

/** 上下文文件条目 */
export interface ContextFileEntry {
  fileName: string;
  content: string;
  loadedAt: number;
  source: 'project' | 'soul';
  charCount: number;
  truncated: boolean;
}

/** 安全扫描结果 */
export interface SecurityScanResult {
  safe: boolean;
  threats: string[];
}

/** 截断结果 */
export interface TruncationResult {
  content: string;
  originalLength: number;
  truncated: boolean;
}

// ==================== 常量 ====================

/**
 * 项目上下文文件优先级列表（先匹配先生效）
 * 参照 Hermes: .hermes.md → AGENTS.md → CLAUDE.md → .cursorrules
 * 家百星适配: JIABAIXING.md → .hermes.md → AGENTS.md → CLAUDE.md → .cursorrules → CONTEXT.md → .jiabaixing/context.md
 */
export const CONTEXT_FILE_PRIORITY = [
  'JIABAIXING.md',
  '.hermes.md',
  'AGENTS.md',
  'CLAUDE.md',
  '.cursorrules',
  'CONTEXT.md',
  '.jiabaixing/context.md',
] as const;

/** SOUL.md 文件名 */
export const SOUL_FILE_NAME = 'SOUL.md';

/** SOUL.md 搜索路径（按优先级） */
export const SOUL_SEARCH_PATHS = [
  'data/SOUL.md', // 数据目录（首选）
  'config/SOUL.md', // 配置目录（兼容旧路径）
  'SOUL.md', // 项目根目录
] as const;

/** 每个文件最大字符数 */
const MAX_FILE_CHARS = 15000;

/** 头部截断比例 */
const HEAD_RATIO = 0.7;

/** 尾部截断比例 */
const TAIL_RATIO = 0.2;

/** Prompt 注入威胁模式 */
const INJECTION_PATTERNS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /ignore\s+previous\s+instructions/i, name: '指令覆盖' },
  { pattern: /disregard\s+your\s+rules/i, name: '规则忽略' },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, name: '欺骗模式' },
  { pattern: /system\s+prompt\s+override/i, name: '系统提示覆盖' },
  { pattern: /<!--[\s\S]*?-->/g, name: '隐藏HTML注释' },
  {
    pattern: /<div\s+style\s*=\s*["']display\s*:\s*none["']/i,
    name: '隐藏div元素',
  },
  {
    pattern: /curl\s+.*\$(?:API_KEY|SECRET|TOKEN|PASSWORD)/i,
    name: '凭据窃取',
  },
  { pattern: /cat\s+(?:\.env|credentials|\.ssh)/i, name: '密钥文件访问' },
  {
    pattern: /[\u200b\u200c\u200d\ufeff\u202a-\u202e\u2060\u2066-\u2069]/,
    name: '不可见字符',
  },
];

// ==================== ContextFileRegistry ====================

/**
 * 上下文文件注册表
 *
 * 统一管理上下文文件的发现、加载、安全扫描和截断。
 * 消除 JiabaixingCore / context_manage / contextManageRoutes 中的重复硬编码。
 */
export class ContextFileRegistry {
  private _cache: ContextFileEntry[] = [];
  private _cacheTimestamp: number = 0;
  private _cacheTtlMs: number;
  private _projectRoot: string;

  constructor(options?: { cacheTtlMs?: number; projectRoot?: string }) {
    this._cacheTtlMs = options?.cacheTtlMs ?? 5 * 60 * 1000;
    this._projectRoot = options?.projectRoot ?? process.cwd();
  }

  // ==================== 公共方法 ====================

  /**
   * 加载所有上下文文件（项目上下文 + SOUL）
   * 使用缓存机制，TTL 内不重复读磁盘
   */
  async loadAll(): Promise<ContextFileEntry[]> {
    const now = Date.now();
    if (
      now - this._cacheTimestamp < this._cacheTtlMs &&
      this._cache.length > 0
    ) {
      return this._cache;
    }

    const entries: ContextFileEntry[] = [];

    // 1. 加载项目上下文（优先级：先匹配先生效，只取第一个）
    const projectEntry = this.loadProjectContext();
    if (projectEntry) {
      entries.push(projectEntry);
    }

    // 2. 加载 SOUL.md（独立插槽，始终加载）
    const soulEntry = this.loadSoulContext();
    if (soulEntry) {
      entries.push(soulEntry);
    }

    this._cache = entries;
    this._cacheTimestamp = Date.now();

    Logger.info(
      `📄 上下文文件已加载: ${entries.length} 个` +
        (projectEntry
          ? ` [项目: ${projectEntry.fileName}]`
          : ' [无项目上下文]') +
        (soulEntry ? ` [SOUL: 已加载]` : ' [无SOUL]'),
      'ContextFileRegistry'
    );

    return entries;
  }

  /**
   * 强制刷新缓存
   */
  async refresh(): Promise<number> {
    this._cacheTimestamp = 0;
    this._cache = [];
    const entries = await this.loadAll();
    return entries.length;
  }

  /**
   * 获取已加载的上下文文件列表
   */
  getLoadedFiles(): ReadonlyArray<ContextFileEntry> {
    return [...this._cache];
  }

  /**
   * 获取项目上下文内容（合并后的文本）
   */
  getProjectContextText(): string {
    const projectEntries = this._cache.filter((e) => e.source === 'project');
    return projectEntries
      .map((e) => `[${e.fileName}]\n${e.content}`)
      .join('\n\n');
  }

  /**
   * 获取 SOUL 上下文内容
   */
  getSoulContextText(): string {
    const soulEntries = this._cache.filter((e) => e.source === 'soul');
    return soulEntries.map((e) => e.content).join('\n\n');
  }

  /**
   * 获取允许创建的文件名列表（供 API 和工具使用）
   */
  getAllowedFileNames(): string[] {
    return [...CONTEXT_FILE_PRIORITY];
  }

  /**
   * 检查文件名是否在允许列表中
   */
  isAllowedFileName(fileName: string): boolean {
    return (CONTEXT_FILE_PRIORITY as readonly string[]).includes(fileName);
  }

  // ==================== 项目上下文加载 ====================

  /**
   * 按优先级加载项目上下文文件
   * 先匹配先生效，只返回优先级最高的一个
   */
  private loadProjectContext(): ContextFileEntry | null {
    for (const fileName of CONTEXT_FILE_PRIORITY) {
      const filePath = path.join(this._projectRoot, fileName);
      try {
        if (fs.existsSync(filePath)) {
          const rawContent = fs.readFileSync(filePath, 'utf-8').trim();
          if (rawContent.length === 0) continue;

          // 安全扫描
          const scanResult = this.scanForInjection(rawContent, fileName);
          if (!scanResult.safe) {
            Logger.warn(
              `⚠️ 上下文文件 ${fileName} 被拦截: ${scanResult.threats.join(', ')}`,
              'ContextFileRegistry'
            );
            continue;
          }

          // 截断
          const truncationResult = this.truncateContent(rawContent, fileName);

          return {
            fileName,
            content: truncationResult.content,
            loadedAt: Date.now(),
            source: 'project',
            charCount: truncationResult.originalLength,
            truncated: truncationResult.truncated,
          };
        }
      } catch (error) {
        Logger.debug(
          `跳过上下文文件 ${fileName}: ${(error as Error).message}`,
          'ContextFileRegistry'
        );
      }
    }

    return null;
  }

  // ==================== SOUL 上下文加载 ====================

  /**
   * 加载 SOUL.md（独立插槽）
   * 搜索路径: data/SOUL.md → config/SOUL.md → SOUL.md
   */
  private loadSoulContext(): ContextFileEntry | null {
    for (const searchPath of SOUL_SEARCH_PATHS) {
      const filePath = path.join(this._projectRoot, searchPath);
      try {
        if (fs.existsSync(filePath)) {
          const rawContent = fs.readFileSync(filePath, 'utf-8').trim();
          if (rawContent.length === 0) continue;

          // 安全扫描
          const scanResult = this.scanForInjection(rawContent, searchPath);
          if (!scanResult.safe) {
            Logger.warn(
              `⚠️ SOUL文件 ${searchPath} 被拦截: ${scanResult.threats.join(', ')}`,
              'ContextFileRegistry'
            );
            continue;
          }

          // 截断
          const truncationResult = this.truncateContent(rawContent, searchPath);

          return {
            fileName: searchPath,
            content: truncationResult.content,
            loadedAt: Date.now(),
            source: 'soul',
            charCount: truncationResult.originalLength,
            truncated: truncationResult.truncated,
          };
        }
      } catch {
        // 跳过读取失败的路径
      }
    }

    return null;
  }

  // ==================== 安全扫描 ====================

  /**
   * 扫描内容是否存在 prompt 注入威胁
   * @param content - 文件内容
   * @param fileName - 文件名（用于日志）
   * @returns 扫描结果
   */
  scanForInjection(content: string, fileName: string): SecurityScanResult {
    const threats: string[] = [];

    for (const { pattern, name } of INJECTION_PATTERNS) {
      if (pattern.test(content)) {
        threats.push(name);
      }
    }

    if (threats.length > 0) {
      Logger.warn(
        `[BLOCKED: ${fileName} contained potential prompt injection (${threats.join(', ')}). Content not loaded.]`,
        'ContextFileRegistry'
      );
    }

    return { safe: threats.length === 0, threats };
  }

  // ==================== 截断策略 ====================

  /**
   * 截断超大文件内容
   * 策略: 70% 头部 + 10% 截断标记 + 20% 尾部
   * @param content - 原始内容
   * @param fileName - 文件名（用于截断标记）
   */
  truncateContent(content: string, fileName: string): TruncationResult {
    if (content.length <= MAX_FILE_CHARS) {
      return { content, originalLength: content.length, truncated: false };
    }

    const headChars = Math.floor(MAX_FILE_CHARS * HEAD_RATIO);
    const tailChars = Math.floor(MAX_FILE_CHARS * TAIL_RATIO);
    const head = content.substring(0, headChars);
    const tail = content.substring(content.length - tailChars);
    const marker = `\n\n[...truncated ${fileName}: kept ${headChars}+${tailChars} of ${content.length} chars. Use file tools to read the full file.]\n\n`;

    return {
      content: head + marker + tail,
      originalLength: content.length,
      truncated: true,
    };
  }
}
