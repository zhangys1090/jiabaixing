/**
 * ObsidianProvider — Obsidian 知识库集成
 *
 * 将 Obsidian vault 作为外部记忆后端。
 * 支持：
 *   - 全文搜索 vault 中的 markdown 笔记
 *   - 创建/更新笔记
 *   - YAML frontmatter 解析
 *   - 标签提取
 *   - [[双向链接]] 检测
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../../utils/Logger';

export interface ObsidianNote {
  /** 文件名（不含 .md） */
  name: string;
  /** 完整文件路径 */
  path: string;
  /** YAML frontmatter */
  frontmatter: Record<string, unknown>;
  /** 正文（不含 frontmatter） */
  body: string;
  /** 完整内容 */
  content: string;
  /** 标签（从 frontmatter 和正文提取） */
  tags: string[];
  /** [[双向链接]] 目标列表 */
  links: string[];
  /** 文件修改时间 */
  mtime: number;
}

export interface ObsidianSearchOptions {
  limit?: number;
  includeContent?: boolean;
}

export class ObsidianProvider {
  private vaultPath: string;
  /** 文件扩展名校验 */
  private static readonly VALID_EXT = '.md';
  /** 排除的目录 */
  private static readonly EXCLUDED_DIRS = new Set([
    '.obsidian',
    '.git',
    'node_modules',
    'trash',
    '.trash',
  ]);

  constructor(vaultPath: string) {
    // 验证 vault 路径
    const resolved = path.resolve(vaultPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Obsidian vault 路径不存在: ${vaultPath}`);
    }
    // 检查 .obsidian 目录作为 vault 标识
    const obsidianDir = path.join(resolved, '.obsidian');
    if (!fs.existsSync(obsidianDir)) {
      Logger.warn(
        `⚠️ 路径 ${vaultPath} 未检测到 .obsidian 目录，仍继续以普通 markdown 目录方式工作`,
        'ObsidianProvider'
      );
    }

    this.vaultPath = resolved;
    Logger.info(
      `📒 Obsidian vault 已连接: ${this.vaultPath}`,
      'ObsidianProvider'
    );
  }

  /** 获取 vault 路径 */
  get vault(): string {
    return this.vaultPath;
  }

  // ==================== 笔记读取 ====================

  /** 按名称读取笔记 */
  getNote(name: string): ObsidianNote | undefined {
    const filePath = this.resolveNotePath(name);
    if (!filePath || !fs.existsSync(filePath)) return undefined;
    return this.parseNote(filePath);
  }

  /** 搜索笔记 */
  searchNotes(
    query: string,
    options: ObsidianSearchOptions = {}
  ): ObsidianNote[] {
    const { limit = 10, includeContent = false } = options;
    const results: ObsidianNote[] = [];
    const lowerQuery = query.toLowerCase();

    const files = this.scanMarkdownFiles();
    for (const filePath of files) {
      if (results.length >= limit) break;
      try {
        const note = this.parseNote(filePath, includeContent);
        // 标题匹配
        if (note.name.toLowerCase().includes(lowerQuery)) {
          results.push(note);
          continue;
        }
        // 标签匹配
        if (note.tags.some((t) => t.toLowerCase().includes(lowerQuery))) {
          results.push(note);
          continue;
        }
        // 内容搜索
        if (includeContent && note.body.toLowerCase().includes(lowerQuery)) {
          results.push(note);
          continue;
        }
      } catch {
        /* 跳过解析失败的文件 */
      }
    }

    return results;
  }

  /** 按标签查找笔记 */
  getNotesByTag(tag: string, limit = 20): ObsidianNote[] {
    const results: ObsidianNote[] = [];
    const files = this.scanMarkdownFiles();
    for (const filePath of files) {
      if (results.length >= limit) break;
      try {
        const note = this.parseNote(filePath, false);
        if (note.tags.includes(tag) || note.tags.includes(`#${tag}`)) {
          results.push(note);
        }
      } catch {
        /* 跳过 */
      }
    }
    return results;
  }

  // ==================== 笔记写入 ====================

  /** 创建或更新笔记 */
  writeNote(
    name: string,
    body: string,
    tags?: string[],
    frontmatter?: Record<string, unknown>
  ): string {
    const fileName = name.endsWith('.md') ? name : `${name}.md`;
    const filePath = path.join(this.vaultPath, fileName);

    // 构建 frontmatter
    const fm: Record<string, unknown> = { ...frontmatter };
    if (tags && tags.length > 0) {
      fm.tags = tags;
    }
    fm.created = fm.created || new Date().toISOString().split('T')[0];
    fm.updated = new Date().toISOString().split('T')[0];

    // 序列化 frontmatter
    const fmLines = ['---'];
    for (const [key, value] of Object.entries(fm)) {
      if (Array.isArray(value)) {
        fmLines.push(`${key}:`);
        for (const item of value) {
          fmLines.push(`  - ${item}`);
        }
      } else {
        fmLines.push(`${key}: ${value}`);
      }
    }
    fmLines.push('---');

    const content = [...fmLines, '', body].join('\n');
    fs.writeFileSync(filePath, content, 'utf-8');
    Logger.debug(`📝 Obsidian 笔记已保存: ${fileName}`, 'ObsidianProvider');
    return filePath;
  }

  // ==================== 知识积累 ====================

  /** 从对话内容创建知识笔记 */
  createKnowledgeNote(params: {
    title: string;
    content: string;
    tags?: string[];
    source?: string;
  }): string {
    const frontmatter: Record<string, unknown> = {};
    if (params.source) frontmatter.source = params.source;
    frontmatter.type = 'knowledge';

    const body = [
      `# ${params.title}`,
      '',
      ...(params.source ? [`> 来源: ${params.source}`, ''] : []),
      params.content,
      '',
      '---',
      '',
    ].join('\n');

    return this.writeNote(
      params.title,
      body,
      ['knowledge', ...(params.tags || [])],
      frontmatter
    );
  }

  // ==================== 内部方法 ====================

  /** 解析笔记名称为完整路径 */
  private resolveNotePath(name: string): string | undefined {
    // 如果已经是完整路径且在 vault 内
    const resolved = path.resolve(name);
    if (resolved.startsWith(this.vaultPath) && fs.existsSync(resolved)) {
      return resolved;
    }

    // 按名称搜索
    const fileName = name.endsWith('.md') ? name : `${name}.md`;
    const directPath = path.join(this.vaultPath, fileName);
    if (fs.existsSync(directPath)) return directPath;

    // 递归搜索
    const files = this.scanMarkdownFiles();
    for (const filePath of files) {
      if (path.basename(filePath).toLowerCase() === fileName.toLowerCase()) {
        return filePath;
      }
    }
    return undefined;
  }

  /** 解析 markdown 文件为 ObsidianNote */
  private parseNote(filePath: string, fullContent = false): ObsidianNote {
    const content = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = this.parseFrontmatter(content);
    const name = path.basename(filePath, '.md');

    return {
      name,
      path: filePath,
      frontmatter,
      body: fullContent ? body : body.substring(0, 500),
      content: fullContent ? content : content.substring(0, 1000),
      tags: this.extractTags(frontmatter, body),
      links: this.extractLinks(body),
      mtime: fs.statSync(filePath).mtimeMs,
    };
  }

  /** 解析 YAML frontmatter */
  private parseFrontmatter(content: string): {
    frontmatter: Record<string, unknown>;
    body: string;
  } {
    const frontmatter: Record<string, unknown> = {};

    if (!content.startsWith('---')) {
      return { frontmatter, body: content };
    }

    const endIdx = content.indexOf('---', 3);
    if (endIdx < 0) return { frontmatter, body: content };

    const fmText = content.substring(3, endIdx).trim();
    const body = content.substring(endIdx + 3).trim();

    for (const line of fmText.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // 数组格式: key:
      //   - value1
      //   - value2
      if (trimmed.endsWith(':') && !trimmed.includes(' ')) {
        const key = trimmed.slice(0, -1);
        frontmatter[key] = [];
        continue;
      }

      // 列表项:   - value
      const listMatch = trimmed.match(/^\s*-\s+(.+)$/);
      if (listMatch) {
        // 找到上一个数组 key
        const keys = Object.keys(frontmatter);
        const lastKey = keys[keys.length - 1];
        if (Array.isArray(frontmatter[lastKey])) {
          (frontmatter[lastKey] as string[]).push(listMatch[1]);
        }
        continue;
      }

      // 内联数组: key: [val1, val2]
      const arrayMatch = trimmed.match(/^(\w[\w_]*):\s*\[(.*)\]$/);
      if (arrayMatch) {
        frontmatter[arrayMatch[1]] = arrayMatch[2]
          .split(',')
          .map((s) => s.trim().replace(/['"]/g, ''));
        continue;
      }

      // 标量: key: value
      const scalarMatch = trimmed.match(/^(\w[\w_]*):\s*(.*)$/);
      if (scalarMatch) {
        frontmatter[scalarMatch[1]] = scalarMatch[2].trim();
      }
    }

    return { frontmatter, body };
  }

  /** 提取标签 */
  private extractTags(
    frontmatter: Record<string, unknown>,
    body: string
  ): string[] {
    const tags = new Set<string>();

    // 从 frontmatter 提取
    const fmTags = frontmatter.tags || frontmatter.tag;
    if (Array.isArray(fmTags)) {
      fmTags.forEach((t) => tags.add(String(t).replace(/^#/, '')));
    } else if (typeof fmTags === 'string') {
      tags.add(fmTags.replace(/^#/, ''));
    }

    // 从正文提取 #tag
    const tagRegex = /#([\w一-龥/-]+)/g;
    let match;
    while ((match = tagRegex.exec(body)) !== null) {
      tags.add(match[1]);
    }

    return Array.from(tags);
  }

  /** 提取 [[双向链接]] */
  private extractLinks(body: string): string[] {
    const links: string[] = [];
    const linkRegex = /\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = linkRegex.exec(body)) !== null) {
      // [[link]] 或 [[link|display]]
      const target = match[1].split('|')[0].split('#')[0].trim();
      if (target && !links.includes(target)) links.push(target);
    }
    return links;
  }

  /** 扫描 vault 中所有 markdown 文件 */
  private scanMarkdownFiles(): string[] {
    const results: string[] = [];
    const walk = (dir: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (ObsidianProvider.EXCLUDED_DIRS.has(entry.name)) continue;
          if (entry.name.startsWith('.')) continue;
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (
            entry.isFile() &&
            entry.name.endsWith(ObsidianProvider.VALID_EXT)
          ) {
            results.push(fullPath);
          }
        }
      } catch {
        /* 跳过无权限目录 */
      }
    };
    walk(this.vaultPath);
    return results;
  }
}
