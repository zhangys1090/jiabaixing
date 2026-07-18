#!/usr/bin/env node
/**
 * CI 护栏：拦截"恒真断言"假测试。
 *
 * 背景：项目曾出现 `expect(true).toBe(true)` 这类空壳测试，
 * 它们永远通过、却什么都不验证——制造"全绿"假象，
 * 让真实 bug（如双重回复、WS 聊天断路）漏过。
 *
 * 本脚本扫描所有 *.test.{ts,tsx} 文件中下列明显恒真的断言模式，
 * 一旦命中即打印位置并以 exit 1 失败，阻断合并。
 *
 * 用法：node scripts/check-no-tautology-tests.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');

// 明显恒真断言模式（字面量 === 自身）
const TAUTOLOGY_PATTERNS = [
  /\bexpect\(\s*true\s*\)\s*\.\s*toBe\(\s*true\s*\)/,
  /\bexpect\(\s*false\s*\)\s*\.\s*toBe\(\s*false\s*\)/,
  /\bexpect\(\s*1\s*\)\s*\.\s*toBe\(\s*1\s*\)/,
  /\bexpect\(\s*0\s*\)\s*\.\s*toBe\(\s*0\s*\)/,
  /\bexpect\(\s*true\s*\)\s*\.\s*toBeTruthy\(\)/,
  /\bexpect\(\s*false\s*\)\s*\.\s*toBeFalsy\(\)/,
];

// 要扫描的根目录（测试所在位置）
const SCAN_ROOTS = ['tests', join('src', 'frontend', 'src')];

// 始终排除依赖目录
const isExcluded = (absPath) =>
  absPath.split(/[\\/]/).some((seg) => seg === 'node_modules' || seg === 'dist' || seg === 'build' || seg === 'release');

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (isExcluded(abs)) continue;
    if (e.isDirectory()) {
      walk(abs, out);
    } else if (e.isFile() && /\.test\.(ts|tsx)$/.test(e.name)) {
      out.push(abs);
    }
  }
  return out;
}

const offenders = [];

for (const root of SCAN_ROOTS) {
  const absRoot = join(repoRoot, root);
  for (const file of walk(absRoot)) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      for (const re of TAUTOLOGY_PATTERNS) {
        if (re.test(line)) {
          offenders.push({
            file: relative(repoRoot, file),
            line: idx + 1,
            snippet: line.trim().slice(0, 80),
          });
          break;
        }
      }
    });
  }
}

if (offenders.length === 0) {
  console.log('✅ 未发现恒真断言空壳测试。');
  process.exit(0);
} else {
  console.error('❌ 发现恒真断言空壳测试（expect(x).toBe(x) 类），这些测试永远通过却什么都不验证：\n');
  for (const o of offenders) {
    console.error(`  - ${o.file}:${o.line}  ${o.snippet}`);
  }
  console.error('\n请将这些用例改写为真实断言（验证具体行为），或删除无意义的空用例。');
  process.exit(1);
}
