#!/usr/bin/env node
/**
 * CI 守卫：核心 tool schema 变更评审闸门。
 *
 * 背景：对标审计指出家百星需"catalog 化窄腰"——核心 Agent 只保留最小必需
 * 工具面，业务/可选能力（插件、技能、MCP）不得污染核心 tool schema。BASE_TOOLSET
 * （python/agent/tools/builtin_toolsets.py）是所有 Agent 默认继承的最小工具集，
 * 它的每一次扩张都等于"核心 schema 变更"，应经过显式评审。
 *
 * 本脚本把 BASE_TOOLSET 的当前静态定义与已评审的基线清单
 * （config/core-tool-schema.baseline.json）比对：
 *   - 新增工具（当前有、基线无）→ 失败（exit 1），要求评审并更新基线；
 *   - 删除工具（基线有、当前无）→ 允许（缩小内核更安全），仅警告；
 *   - 完全一致 → 通过。
 *
 * 这保证"核心工具面只增不减须经评审"，且可选能力若被误塞进 BASE_TOOLSET
 * 会在 CI 立即暴露（而不是静默污染每个 Agent）。
 *
 * 用法：node scripts/check-core-tool-schema.mjs
 * 旁路：若确属评审通过的扩张，更新基线清单后重跑即可通过。
 */

import { readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(__dirname, '..');

const BUILTIN_TOOLSETS = resolve(repoRoot, 'python', 'agent', 'tools', 'builtin_toolsets.py');
const BASELINE = resolve(repoRoot, 'config', 'core-tool-schema.baseline.json');

/** 解析 BASE_TOOLSET 块内的条目（category:xxx 或 name）。 */
function parseBaseToolset(src) {
  const start = src.indexOf('BASE_TOOLSET = ToolsetDefinition(');
  if (start === -1) throw new Error('未找到 BASE_TOOLSET 定义');
  // 找到起始 '(' 后匹配到配平的 ')'
  const open = src.indexOf('(', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error('BASE_TOOLSET 括号不匹配');
  const block = src.slice(open + 1, end);

  const entries = [];
  const re = /ToolsetEntry\(\s*(?:category\s*=\s*ToolCategory\.(\w+)|name\s*=\s*"([^"]+)")/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    if (m[1]) entries.push(`category:${m[1].toLowerCase()}`);
    else if (m[2]) entries.push(m[2]);
  }
  return entries;
}

function normalize(list) {
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))].sort();
}

function fail(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function main() {
  let src;
  try {
    src = readFileSync(BUILTIN_TOOLSETS, 'utf-8');
  } catch (e) {
    fail(`无法读取核心工具集定义: ${BUILTIN_TOOLSETS} (${e.message})`);
  }

  let current;
  try {
    current = normalize(parseBaseToolset(src));
  } catch (e) {
    fail(`解析 BASE_TOOLSET 失败: ${e.message}`);
  }

  let baseline;
  try {
    const raw = JSON.parse(readFileSync(BASELINE, 'utf-8'));
    baseline = normalize(raw.entries || []);
  } catch (e) {
    fail(`无法读取/解析基线清单: ${BASELINE} (${e.message})`);
  }

  const added = current.filter((t) => !baseline.includes(t));
  const removed = baseline.filter((t) => !current.includes(t));

  const relSrc = relative(repoRoot, BUILTIN_TOOLSETS);
  const relBase = relative(repoRoot, BASELINE);

  if (added.length > 0) {
    console.error('');
    console.error(`⛔ 核心 tool schema 扩张被拦截：BASE_TOOLSET 新增了未在基线清单中的工具。`);
    console.error(`   源: ${relSrc}`);
    console.error(`   基线: ${relBase}`);
    console.error(`   新增(${added.length}): ${added.join(', ')}`);
    console.error('');
    console.error('   评审流程：核心工具面扩张须经人工评审。确认无误后，更新');
    console.error(`   ${relBase} 的 "entries"，把这些工具加入并提交（在 _comment / 提交说明里写清理由）。`);
    console.error('   可选能力（插件/技能/MCP）不应进入 BASE_TOOLSET，应走 optional 目录。');
    console.error('');
    fail(`核心 tool schema 变更未经评审（${added.length} 个新增）`);
  }

  if (removed.length > 0) {
    console.warn(
      `⚠️  BASE_TOOLSET 删除了 ${removed.length} 个核心工具: ${removed.join(', ')}。` +
        ` 缩小内核允许通过，但请确认无 Agent 依赖被移除的工具；建议同步更新基线与调用点。`
    );
  }

  console.log(
    `✅ 核心 tool schema 校验通过：BASE_TOOLSET 共 ${current.length} 个条目，与基线一致（无未评审扩张）。`
  );
  if (removed.length > 0) {
    console.log(`   提示：移除项已不在 BASE_TOOLSET，可同步清理 ${relBase} 以免基线漂移。`);
  }
  process.exit(0);
}

main();
