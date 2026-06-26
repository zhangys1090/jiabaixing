/**
 * 语言文件模式检测工具函数
 * 从 Planner 提取，供 ContextManager 等模块共享使用，避免跨层依赖
 */

import { Logger } from '../../utils/Logger';

/** 语言关键词 → 文件匹配模式映射 */
const LANGUAGE_TO_FILE_PATTERN: Record<string, string> = {
  python: '*.py',
  java: '*.java',
  javascript: '*.js',
  js: '*.js',
  typescript: '*.ts',
  ts: '*.ts',
  react: '*.tsx',
  vue: '*.vue',
  go: '*.go',
  rust: '*.rs',
  c: '*.c',
  cpp: '*.cpp',
  'c++': '*.cpp',
  'c#': '*.cs',
  csharp: '*.cs',
  ruby: '*.rb',
  php: '*.php',
  swift: '*.swift',
  kotlin: '*.kt',
  scala: '*.scala',
  html: '*.html',
  css: '*.css',
  sql: '*.sql',
  shell: '*.sh',
  bash: '*.bash',
};

/**
 * 从用户输入文本中检测语言关键词，返回对应的 filePattern。
 * 使用词边界避免误匹配 (如 "jsonp" → "json")。
 *
 * @param text 用户输入文本
 * @returns 文件匹配模式，如果未检测到语言则返回 null
 */
export function detectLanguageFilePatternFromInput(
  text: string
): string | null {
  const lowerText = text.toLowerCase();
  const sortedKeys = Object.keys(LANGUAGE_TO_FILE_PATTERN).sort(
    (a, b) => b.length - a.length
  );
  for (const key of sortedKeys) {
    if (lowerText.includes(key)) {
      const filePattern = LANGUAGE_TO_FILE_PATTERN[key];
      Logger.debug(
        `🔍 检测到语言关键词 "${key}" → filePattern: ${filePattern}`,
        'LanguageDetector'
      );
      return filePattern;
    }
  }
  return null;
}
