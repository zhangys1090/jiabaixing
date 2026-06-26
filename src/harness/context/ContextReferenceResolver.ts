/**
 * ContextReferenceResolver - 上下文系统辅助组件
 *
 * 【架构定位】
 * 上下文系统辅助组件，负责用户输入中的 @ 引用解析
 *
 * 【核心职责】
 * - 解析消息中的 @ 引用（@文件名、@文件夹、@URL、@git_diff）
 * - 将引用内容内联展开到上下文中
 * - 支持多种引用类型：文件、文件夹、URL、git diff
 * - 错误处理与降级
 *
 * 【在整体架构中的位置】
 * 用户输入 → ContextReferenceResolver（本文件）→ UnifiedContextPipeline
 *
 * 【使用场景】
 * - 用户输入中包含 @文件名 引用时
 * - 需要将文件内容注入上下文时
 * - 支持代码审查、文档分析等场景
 *
 * 设计参考: Hermes Agent 上下文引用系统
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { Logger } from '../../utils/Logger';

/** 引用类型 */
export type ReferenceType = 'file' | 'folder' | 'url' | 'git_diff';

/** 解析出的引用 */
export interface ResolvedReference {
  type: ReferenceType;
  target: string;
  content: string;
  error?: string;
  charCount: number;
}

/** 解析结果 */
export interface ResolveResult {
  hasReferences: boolean;
  references: ResolvedReference[];
  resolvedContent: string;
  cleanedInput: string;
}

/** @ 引用正则：@url 优先匹配，再匹配 @path */
const REFERENCE_PATTERN = /@(https?:\/\/[^\s]+)|@([\w./\-]+(?:\.[\w]+)?)/g;

/** 文件最大字符数 */
const MAX_FILE_CHARS = 15000;

export class ContextReferenceResolver {
  private projectRoot: string;

  constructor(options: { projectRoot: string }) {
    this.projectRoot = options.projectRoot;
  }

  /**
   * 解析输入中的所有 @ 引用
   * @param input - 用户输入文本
   * @returns 解析结果，包含引用列表和展开内容
   */
  async resolve(input: string): Promise<ResolveResult> {
    const references: ResolvedReference[] = [];
    const contentParts: string[] = [];
    let cleanedInput = input;

    // 收集所有匹配
    const matches: Array<{ fullMatch: string; target: string; index: number }> =
      [];
    let match: RegExpExecArray | null;

    const pattern = new RegExp(
      REFERENCE_PATTERN.source,
      REFERENCE_PATTERN.flags
    );
    while ((match = pattern.exec(input)) !== null) {
      matches.push({
        fullMatch: match[0],
        target: match[1] || match[2],
        index: match.index,
      });
    }

    if (matches.length === 0) {
      return {
        hasReferences: false,
        references: [],
        resolvedContent: '',
        cleanedInput: input,
      };
    }

    // 逐个解析引用
    for (const m of matches) {
      const ref = this.resolveReference(m.target);
      references.push(ref);

      if (ref.content && !ref.error) {
        contentParts.push(
          `--- @${m.target} ---\n${ref.content}\n--- end @${m.target} ---`
        );
      }

      // 清理输入中的 @ 前缀
      cleanedInput = cleanedInput.replace(m.fullMatch, m.target);
    }

    Logger.info(
      `📎 解析了 ${references.length} 个 @ 引用`,
      'ContextReferenceResolver'
    );

    return {
      hasReferences: true,
      references,
      resolvedContent: contentParts.join('\n\n'),
      cleanedInput,
    };
  }

  /**
   * 解析单个引用
   * @param target - 引用目标（文件路径、URL 或 git_diff）
   * @returns 解析出的引用结果
   */
  private resolveReference(target: string): ResolvedReference {
    // URL 引用
    if (target.startsWith('http://') || target.startsWith('https://')) {
      return this.resolveUrl(target);
    }

    // git_diff 引用
    if (target === 'git_diff' || target === 'git-diff') {
      return this.resolveGitDiff();
    }

    // 文件路径 — 安全校验：防止路径遍历
    const fullPath = path.resolve(this.projectRoot, target);

    if (
      !fullPath.startsWith(this.projectRoot + path.sep) &&
      fullPath !== this.projectRoot
    ) {
      return {
        type: 'file',
        target,
        content: '',
        error: `路径不允许: ${target}（超出项目根目录）`,
        charCount: 0,
      };
    }

    if (!fs.existsSync(fullPath)) {
      return {
        type: 'file',
        target,
        content: '',
        error: `文件不存在: ${target}`,
        charCount: 0,
      };
    }

    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      return this.resolveFolder(target, fullPath);
    }

    return this.resolveFile(target, fullPath);
  }

  /**
   * 解析文件引用
   * @param target - 相对路径
   * @param fullPath - 绝对路径
   * @returns 文件引用解析结果
   */
  private resolveFile(target: string, fullPath: string): ResolvedReference {
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const truncated = content.length > MAX_FILE_CHARS;
      const finalContent = truncated
        ? content.substring(0, MAX_FILE_CHARS) +
          `\n\n[...truncated: ${content.length} chars total, showing first ${MAX_FILE_CHARS}]`
        : content;

      return {
        type: 'file',
        target,
        content: finalContent,
        charCount: finalContent.length,
      };
    } catch (err) {
      return {
        type: 'file',
        target,
        content: '',
        error: `读取失败: ${(err as Error).message}`,
        charCount: 0,
      };
    }
  }

  /**
   * 解析文件夹引用（列出目录结构）
   * @param target - 相对路径
   * @param fullPath - 绝对路径
   * @returns 文件夹引用解析结果
   */
  private resolveFolder(target: string, fullPath: string): ResolvedReference {
    try {
      const entries = this.listDirectory(fullPath, 3);
      const content = `目录结构 (${target}):\n${entries}`;

      return {
        type: 'folder',
        target,
        content,
        charCount: content.length,
      };
    } catch (err) {
      return {
        type: 'folder',
        target,
        content: '',
        error: `读取目录失败: ${(err as Error).message}`,
        charCount: 0,
      };
    }
  }

  /**
   * 解析 URL 引用（标记为需异步获取）
   * @param target - URL 地址
   * @returns URL 引用解析结果
   */
  private resolveUrl(target: string): ResolvedReference {
    return {
      type: 'url',
      target,
      content: `[URL引用: ${target} — 需通过 web_fetch 工具获取内容]`,
      charCount: 0,
    };
  }

  /**
   * 解析 git_diff 引用
   * @returns git diff 解析结果
   */
  private resolveGitDiff(): ResolvedReference {
    try {
      const diff = execSync('git diff --stat && echo "---" && git diff', {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });

      const truncated = diff.length > MAX_FILE_CHARS;
      const content = truncated
        ? diff.substring(0, MAX_FILE_CHARS) +
          `\n\n[...truncated: ${diff.length} chars total]`
        : diff;

      return {
        type: 'git_diff',
        target: 'git_diff',
        content,
        charCount: content.length,
      };
    } catch (err) {
      return {
        type: 'git_diff',
        target: 'git_diff',
        content: '',
        error: `获取 git diff 失败: ${(err as Error).message}`,
        charCount: 0,
      };
    }
  }

  /**
   * 列出目录结构
   * @param dirPath - 目录路径
   * @param maxDepth - 最大递归深度
   * @param prefix - 缩进前缀
   * @returns 目录树文本
   */
  private listDirectory(
    dirPath: string,
    maxDepth: number,
    prefix: string = ''
  ): string {
    const lines: string[] = [];
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const visible = entries.filter(
        (e) => !e.name.startsWith('.') && e.name !== 'node_modules'
      );

      for (const entry of visible.slice(0, 50)) {
        const fullPath = path.join(dirPath, entry.name);
        lines.push(
          `${prefix}${entry.isDirectory() ? '📁' : '📄'} ${entry.name}`
        );

        if (entry.isDirectory() && maxDepth > 1) {
          const subLines = this.listDirectory(
            fullPath,
            maxDepth - 1,
            prefix + '  '
          );
          lines.push(...subLines.split('\n').filter(Boolean));
        }
      }
    } catch {
      lines.push(`${prefix}[读取失败]`);
    }
    return lines.join('\n');
  }
}
