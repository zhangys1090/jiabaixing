#!/usr/bin/env node
/**
 * doc-derived-audit.mjs — 文档派生审计探针
 * ------------------------------------------------------------------
 * 方法论：把项目文档(AGENTS.md / ARCHITECTURE.md)里的"断言"当成规格,
 *         逐条派生成可执行检查,跑一遍。失败点 = 文档与代码不一致的真问题,
 *         再由人判定根因(文档过期 / 代码缺失 / 死代码 / 假绿)。
 *
 * 只读探针：本脚本绝不修改任何源码或文档。
 *
 * 用法:  node scripts/doc-derived-audit.mjs
 * 产物:  控制台结构化报告 + docs/doc-derived-audit-result.json
 * 退出码: 有 FAIL 时返回 1(便于接入 CI),否则 0。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---- 代码索引(只索引生产代码,排除发布副本/依赖/构建产物) --------------
const EXCLUDE = [
  path.join('src', 'frontend', 'release'),
  path.join('src', 'frontend', 'node_modules'),
  'node_modules',
  'dist',
  'coverage',
];
const isExcluded = (p) => EXCLUDE.some((e) => p.includes(e));

function walk(dir, exts, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (isExcluded(full)) continue;
    if (ent.isDirectory()) walk(full, exts, acc);
    else if (exts.some((x) => ent.name.endsWith(x))) acc.push(full);
  }
  return acc;
}

const tsFiles = walk(path.join(ROOT, 'src'), ['.ts', '.tsx']);
const pyFiles = walk(path.join(ROOT, 'python', 'agent'), ['.py']);
const testFiles = walk(path.join(ROOT, 'tests'), ['.ts', '.tsx', '.js']);

const cache = new Map();
function read(f) {
  if (cache.has(f)) return cache.get(f);
  let c = '';
  try {
    c = fs.readFileSync(f, 'utf8');
  } catch {
    /* ignore */
  }
  cache.set(f, c);
  return c;
}
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/** 在生产 TS 代码里查找类被"引用/实例化"(排除定义文件本身与测试) */
function prodRefs(className, defFileRel) {
  const defAbs = defFileRel ? path.join(ROOT, defFileRel) : null;
  const reNew = new RegExp(`new\\s+${className}\\b`);
  const reImport = new RegExp(`\\b${className}\\b`);
  const hits = [];
  for (const f of tsFiles) {
    if (defAbs && f === defAbs) continue;
    const c = read(f);
    if (reNew.test(c) || reImport.test(c)) {
      hits.push(path.relative(ROOT, f).replace(/\\/g, '/'));
    }
  }
  return hits;
}

/**
 * 仅统计"类被实例化 / 方法调用"的活跃用法(排除 interface 类型注解、测试、定义文件自身)。
 * 用于 AGENTS.md §0.1 判定: TS 不得【实现】核心类,但保留 interface/type 契约(桥接类型)是允许的。
 */
function activeClassRefs(className, defFileRel) {
  const defAbs = defFileRel ? path.join(ROOT, defFileRel) : null;
  const reNew = new RegExp(`new\\s+${className}\\b`);
  const reCall = new RegExp(`\\b${className}\\s*\\.\\s*[A-Za-z_$]\\w*\\s*\\(`);
  const hits = [];
  for (const f of tsFiles) {
    if (defAbs && f === defAbs) continue;
    if (
      f.includes(path.sep + 'tests' + path.sep) ||
      f.endsWith('.test.ts') ||
      f.endsWith('.test.tsx')
    )
      continue;
    const c = read(f);
    if (reNew.test(c) || reCall.test(c))
      hits.push(path.relative(ROOT, f).replace(/\\/g, '/'));
  }
  return hits;
}

function findDef(className, files) {
  const re = new RegExp(`\\bclass\\s+${className}\\b`);
  return files.filter((f) => re.test(read(f))).map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
}
const hasDeprecated = (rel) => /@deprecated/i.test(read(path.join(ROOT, rel)));

// ---- 结果收集 ----------------------------------------------------------
const results = [];
function record(source, id, assertion, pass, evidence, rootCause, recommendation) {
  results.push({ source, id, assertion, pass, evidence, rootCause, recommendation });
}

// =====================================================================
// 规格源 A —— AGENTS.md §0.1 模块归属表(TS 侧不得独立实现 Agent 核心)
// 断言: 核心模块的 TS 侧必须"已删除"或"@deprecated 且不被生产代码实例化"。
// =====================================================================
function tsModuleIsInert(label, className, defFileRel) {
  // 仅匹配 class 实现(interface/type 契约允许保留,符合 §0.1"TS 不得实现核心"而非"不得声明类型")
  const classDefs = findDef(className, tsFiles);
  if (classDefs.length === 0) {
    return record('AGENTS§0.1', `A-${label}`, `TS 侧不得独立实现「${label}」`, true,
      `TS 侧无 class ${className} 实现(仅可能保留 interface/type 契约,已迁移 Python)`, '符合(已删除实现)', '无需处理');
  }
  const def = defFileRel || classDefs[0];
  const dep = hasDeprecated(def);
  // 仅统计"类被实例化/方法调用"的活跃用法(interface 类型注解不计入)
  const activeRefs = activeClassRefs(className, def).filter((r) => !r.endsWith('index.ts'));
  if (!dep) {
    return record('AGENTS§0.1', `A-${label}`, `TS 侧不得独立实现「${label}」`, false,
      `${def} 存在 class ${className} 且【未标 @deprecated】; 活跃调用点: ${activeRefs.slice(0, 4).join(', ') || '(仅定义)'}`,
      '代码违规: TS 侧活跃独立实现核心', '迁移到 Python / 或降级为转发壳并标 @deprecated');
  }
  if (activeRefs.length > 0) {
    return record('AGENTS§0.1', `A-${label}`, `TS 侧「${label}」应已废弃且不被生产实例化`, false,
      `${def} 标了 @deprecated,但仍被生产代码实例化/调用: ${activeRefs.slice(0, 5).join(', ')}`,
      '注释与现实脱节: 标"已迁移/默认不用"却仍在核心调用路径', '要么真正切到 Python 桥、删除 TS 引用;要么修正注释');
  }
  return record('AGENTS§0.1', `A-${label}`, `TS 侧「${label}」已废弃且无生产实例化`, true,
    `${def} @deprecated 且无活跃实例化(仅保留作为 interface 契约或本地回退存根)`, '符合(转发壳/停用)', '无需处理');
}

tsModuleIsInert('LLM-Provider', 'LLMProvider', 'src/models/LLMProvider.ts');
tsModuleIsInert('LLM-MultiModel', 'MultiModelLLMProvider', 'src/models/MultiModelLLMProvider.ts');
tsModuleIsInert('Memory-Engine', 'MemoryEngine', 'src/memory/MemoryEngine.ts');
tsModuleIsInert('Memory-ShortTerm', 'ShortTermMemory', 'src/memory/ShortTermMemory.ts');
tsModuleIsInert('Memory-LongTerm', 'LongTermMemory', 'src/memory/LongTermMemory.ts');
tsModuleIsInert('Memory-VectorDB', 'VectorDatabase', 'src/memory/VectorDatabaseFactory.ts');
tsModuleIsInert('Loop-Controller', 'LoopController', null);
tsModuleIsInert('Evolution-Engine', 'EvolutionEngine', 'src/evolution/EvolutionEngine.ts');
tsModuleIsInert('A2A-Manager', 'A2AProtocolManager', null);

// —— 以下 5 行为 §0.1 归属表「其余行」补全覆盖(之前探针未覆盖) ——
tsModuleIsInert('Redis-Cache', 'RedisCache', null); // 真实 src/ 已无 class → findDef===0 → PASS
tsModuleIsInert('MQ-MessageQueue', 'MessageQueue', null); // 真实 src/ 无独立 MQ 类 → PASS
tsModuleIsInert('LLM-CredentialPool', 'CredentialPool', 'src/models/ProviderManager.ts'); // 整文件已 @deprecated → PASS
tsModuleIsInert('Persistence-Session', 'SessionStore', 'src/persistence/SessionStore.ts'); // 已收口: 重导出壳(SessionStore.ts)+@deprecated 桥接回退
tsModuleIsInert('Persistence-Trajectory', 'TrajectoryDatabase', 'src/harness/persistence/TrajectoryDatabase.ts'); // 已收口: 重导出壳+@deprecated 桥接回退

// A-OTel-SDK: §0.1「OpenTelemetry 追踪」行 — TS 仅透传, 禁止独立 OTel SDK 集成
// 已收口: PerformanceMonitor 移除 NodeSDK/OTLPTraceExporter/PrometheusExporter import 与 initOTel(), 改为 traceId 透传壳
{
  const OTEL_SDK_RE = /@opentelemetry\/sdk-node/;
  const hitFiles = tsFiles.filter((f) => OTEL_SDK_RE.test(read(f)));
  const active = hitFiles.filter((f) => /initOTel\s*\(/.test(read(f)) && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'));
  const pass = hitFiles.length === 0;
  record('AGENTS§0.1', 'A-OTel-SDK', 'TS 侧不得独立集成 OTel SDK(仅透传 traceId)', pass,
    pass ? 'TS 侧未发现 @opentelemetry/sdk-node 独立集成'
      : `TS 侧集成 OTel SDK: ${hitFiles.map((f) => path.relative(ROOT, f).replace(/\\/g, '/')).join(', ')} (initOTel 活跃调用: ${active.length})`,
    pass ? '符合' : '代码违规: TS 侧直接 new NodeSDK 并 initOTel()(bootstrap 生产调用), 违背 §0.1「仅透传」',
    pass ? '无需处理' : '标记 @deprecated 改为仅透传 traceId, 或在 §0.1 注明 TS 运维可观测性例外');
}

// MCPServerManager: 文档注释自称"仅 HTTP 路由入口",断言其为薄转发(行数 < 300)
{
  const rel = 'src/mcp/MCPServerManager.ts';
  if (exists(rel)) {
    const lines = read(path.join(ROOT, rel)).split('\n').length;
    const thin = lines < 300;
    record('AGENTS§0.1', 'A-MCP', 'MCPServerManager 应为薄 HTTP 入口(业务在 Python)', thin,
      `${rel} 共 ${lines} 行(阈值<300 视为薄壳)`,
      thin ? '符合' : '代码违规: 挂"仅路由"之名,实为完整业务逻辑(spawn/JSON-RPC/SSE)',
      thin ? '无需处理' : '把 MCP 业务逻辑迁移到 python/agent/mcp,TS 仅保留路由');
  }
}

// =====================================================================
// 规格源 B —— ARCHITECTURE.md §1.5 功能对齐表(每个 ✅ 组件须存在且被挂载)
// 断言: 组件类已定义,且在生产代码(非测试/非自身)被 import 或实例化。
// =====================================================================
const COMPONENTS = [
  ['ContextReferenceResolver', 'src/harness/context/ContextReferenceResolver.ts'],
  ['BatchProcessor', 'src/harness/batch/BatchProcessor.ts'],
  ['SandboxExecutor', 'src/harness/sandbox/SandboxExecutor.ts'],
  ['HookManager', 'src/harness/hooks/HookManager.ts'],
  ['SkillRegistry', 'src/skills/SkillRegistry.ts'],
  ['CuratorService', 'src/curator/CuratorService.ts'],
  ['SpeechSynthesizer', 'src/interaction/SpeechSynthesizer.ts'],
  ['ExternalMemoryProvider', 'src/memory/external/ExternalMemoryProvider.ts'],
  ['ACPServer', 'src/ide/ACPServer.ts'],
  ['TrajectoryExporter', 'src/training/TrajectoryExporter.ts'],
];
for (const [cls, defRel] of COMPONENTS) {
  const defExists = defRel ? exists(defRel) : findDef(cls, tsFiles).length > 0;
  if (!defExists) {
    record('ARCH§1.5', `B-${cls}`, `✅「${cls}」应在 TS 侧存在且被挂载`, false,
      `TS 侧未找到 ${cls} 定义`, '文档过期: 点名的 TS 组件实为 Python 端组件或已删除',
      '从 §1.5/§3.4 移除该 TS 点名,或改标注为 Python 组件');
    continue;
  }
  const def = defRel || findDef(cls, tsFiles)[0];
  const refs = prodRefs(cls, def).filter((r) => !r.startsWith('tests/') && !r.endsWith('index.ts'));
  const mounted = refs.length > 0;
  record('ARCH§1.5', `B-${cls}`, `✅「${cls}」应被生产代码挂载`, mounted,
    mounted ? `引用于: ${refs.slice(0, 4).join(', ')}` : `${def} 定义存在,但无生产引用(仅自身/仅测试/仅CLI)`,
    mounted ? '符合' : '死代码/未挂载: 文档标 ✅ 但生产链路未装配',
    mounted ? '无需处理' : '接入生产装配,或将 §1.5 该项从 ✅ 降级');
}

// §1.5 中文档已标注为 Python 端的组件: 核验其 Python 指向真实存在(可含指定类)
// 结构: [标签, Python 相对路径, 期望类名或 null]
const PY_COMPONENTS = [
  ['TTS(voice_mode)', 'python/agent/tools/voice_mode_tool.py', null],
  ['PromptCacheManager', 'python/agent/llm/prompt_cache.py', 'PromptCacheManager'],
  ['CheckpointService', 'python/agent/persistence/checkpoint.py', 'CheckpointService'],
  ['Mem0Provider', 'python/agent/memory/providers.py', 'Mem0Provider'],
  ['VoiceSessionManager', 'python/agent/tools/voice_mode_tool.py', 'VoiceModeManager'],
  ['PluginManager', 'python/agent/plugins/manager.py', 'PluginManager'],
  ['PluginLoader', 'python/agent/plugins/manager.py', null],
];
for (const [label, rel, cls] of PY_COMPONENTS) {
  const fileOk = exists(rel);
  const classOk = fileOk && (cls === null || new RegExp(`\\bclass\\s+${cls}\\b`).test(read(path.join(ROOT, rel))));
  const ok = fileOk && classOk;
  record('ARCH§1.5', `B-PY-${label}`, `✅「${label}」文档标注的 Python 指向应真实存在`, ok,
    ok ? `Python 实现存在: ${rel}${cls ? ` (含 class ${cls})` : ''}`
       : (!fileOk ? `Python 文件缺失: ${rel}` : `${rel} 存在但未找到 class ${cls}`),
    ok ? '符合(文档已正确指向 Python)' : '文档指向的 Python 实现不存在',
    ok ? '无需处理' : '修正文档 Python 路径或补齐 Python 实现');
}

// =====================================================================
// 规格源 C —— AGENTS.md §0.3 完成标准(无空体 skip / 无恒真断言)
// =====================================================================
// C1: 恒真断言(复用既有守卫)
{
  let pass = true, evidence = '';
  try {
    execSync('node scripts/check-no-tautology-tests.mjs', { cwd: ROOT, stdio: 'pipe' });
    evidence = '恒真断言守卫: 0 命中';
  } catch (e) {
    pass = false;
    evidence = String(e.stdout || e.message).slice(0, 300);
  }
  record('AGENTS§0.3', 'C-tautology', '测试不得含恒真断言空壳', pass, evidence,
    pass ? '符合' : '假绿', pass ? '无需处理' : '重写为真实断言');
}
// C2: 空体 skip 存根(如 test.skip('...', async()=>{}) )
{
  const stubs = [];
  const reStub = /(?:test|it|describe)\.skip\s*\([^)]*,\s*async?\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g;
  for (const f of testFiles) {
    const c = read(f);
    let m;
    while ((m = reStub.exec(c)) !== null) {
      const line = c.slice(0, m.index).split('\n').length;
      stubs.push(`${path.relative(ROOT, f).replace(/\\/g, '/')}:${line}`);
    }
  }
  record('AGENTS§0.3', 'C-stub-skip', '不得存在空体 skip 存根(占位假实现)', stubs.length === 0,
    stubs.length ? stubs.join(', ') : '未发现空体 skip 存根',
    stubs.length ? '假绿: skip 掉空测试冒充覆盖' : '符合',
    stubs.length ? '删除存根或补真实测试(勿 skip 空体)' : '无需处理');
}

// =====================================================================
// 规格源 D —— ARCHITECTURE.md 全局架构描述(文件指向 / 存储引擎)
// =====================================================================
// D1: 文档"实时"点名的 TS 文件是否仍存在(动态解析当前 ARCHITECTURE.md,而非硬编码快照)
// 关注 §3.4 缓存相关的 src/models/*.ts 指向,凡文档写到但磁盘缺失即视为悬空指针。
{
  const arch = read(path.join(ROOT, 'ARCHITECTURE.md'));
  const CACHE_TS_RE = /src\/models\/(SqliteCacheStore|PromptCacheManager|PromptCache|RedisCache)\.ts/g;
  const pointed = [...new Set([...arch.matchAll(CACHE_TS_RE)].map((m) => `src/models/${m[1]}.ts`))];
  const missing = pointed.filter((f) => !exists(f));
  record('ARCH§3.4', 'D-dangling-path', 'ARCHITECTURE 文档(实时)点名的缓存 TS 文件应真实存在', missing.length === 0,
    missing.length ? `文档仍指向但已不存在: ${missing.join(', ')}`
      : (pointed.length ? '文档点名路径均存在' : '文档已不再点名已删除的 TS 缓存路径(已对齐 Python)'),
    missing.length ? '文档过期: 指向已删除文件(缓存已迁 python/agent/llm)' : '符合',
    missing.length ? '更新文档: 这些是 Python 组件,删除 TS 路径点名' : '无需处理');
}
// D2: 端口描述完整性(文档只写 3111,未提 Python 3112)
{
  const arch = read(path.join(ROOT, 'ARCHITECTURE.md'));
  const has3112 = /3112/.test(arch);
  record('ARCH§1.1', 'D-port', '端口描述应覆盖 Python 后端(3112)', has3112,
    has3112 ? '文档含 3112' : '文档仅描述 3111,未提 Python 后端 3112',
    has3112 ? '符合' : '文档不完整: 未反映 TS 网关(3111)+Python 后端(3112)双端',
    has3112 ? '无需处理' : '补充 3112 端口与 AGENT_BACKEND=python 描述');
}
// D3: 存储引擎宏观描述(ChromaDB vs 实际 SQLite/FTS5 中心)
{
  const arch = read(path.join(ROOT, 'ARCHITECTURE.md'));
  const claimsChroma = /ChromaDB/.test(arch);
  record('ARCH', 'D-storage', '存储描述应反映实际(Python 中心 SQLite/FTS5)', !claimsChroma,
    claimsChroma ? 'ARCHITECTURE 仍宣称 "SQLite + ChromaDB 双向量存储"(TS 中心)' : '未发现过期 Chroma 宏观描述',
    claimsChroma ? '文档过期: 实际运行为 Python 中心 SQLite/FTS5;ChromaVectorDatabase.ts 仅 TS 遗留' : '符合',
    claimsChroma ? '更新宏观架构描述为 Python 中心存储' : '无需处理');
}

// ---- 输出 --------------------------------------------------------------
const bySource = {};
for (const r of results) (bySource[r.source] ||= []).push(r);
const fails = results.filter((r) => !r.pass);
const passes = results.filter((r) => r.pass);

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', d: '\x1b[2m', x: '\x1b[0m', b: '\x1b[1m' };
console.log(`\n${C.b}=== 文档派生审计探针 ===${C.x}`);
console.log(`索引: TS ${tsFiles.length} 文件 / Python ${pyFiles.length} 文件 / 测试 ${testFiles.length} 文件\n`);
for (const [src, rs] of Object.entries(bySource)) {
  console.log(`${C.b}【${src}】${C.x}`);
  for (const r of rs) {
    const tag = r.pass ? `${C.g}PASS${C.x}` : `${C.r}FAIL${C.x}`;
    console.log(`  ${tag} ${r.id}  ${r.assertion}`);
    if (!r.pass) {
      console.log(`       ${C.d}证据:${C.x} ${r.evidence}`);
      console.log(`       ${C.y}根因:${C.x} ${r.rootCause}`);
    }
  }
  console.log('');
}
console.log(`${C.b}小结${C.x}: ${C.g}${passes.length} PASS${C.x} / ${C.r}${fails.length} FAIL${C.x} (共 ${results.length} 条断言)`);

const outDir = path.join(ROOT, 'docs');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'doc-derived-audit-result.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), summary: { pass: passes.length, fail: fails.length, total: results.length }, results }, null, 2),
);
console.log(`\n结果已写入 docs/doc-derived-audit-result.json`);
process.exitCode = fails.length > 0 ? 1 : 0;
