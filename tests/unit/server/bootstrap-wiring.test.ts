/**
 * bootstrap 启动接线回归锁（审计 §1.8 W2 / W5）
 *
 * 这两个缺陷都属于"接线断裂 + 假成功"，且都只在**语句顺序**上体现，
 * 类型检查与常规单测都抓不到，因此用源码顺序断言锁死：
 *
 * - W5：MCP Host 启动块原先位于 Python 桥接**之前**，
 *       getActivePythonBridge() 恒返回 null → startAllMcpServers() 从未执行，
 *       却照常打印 ✅。
 * - W2：TS Harness 原先无条件构建。Python 后端为主实现时整套 TS Loop/Tools/
 *       Context/Verification 空转，违反 AGENTS.md §0.1，且制造双端并存假象。
 */

import * as fs from 'fs';
import * as path from 'path';

const BOOTSTRAP_PATH = path.resolve(__dirname, '../../../src/server/bootstrap.ts');

function readBootstrap(): string {
  return fs.readFileSync(BOOTSTRAP_PATH, 'utf-8');
}

/** 取某个片段在源码中的首次出现位置，找不到则断言失败。 */
function indexOfOrFail(src: string, needle: string): number {
  const idx = src.indexOf(needle);
  expect(idx).toBeGreaterThanOrEqual(0);
  return idx;
}

describe('bootstrap 启动接线', () => {
  let src: string;

  beforeAll(() => {
    src = readBootstrap();
  });

  describe('W5：MCP Host 必须在 Python 桥接建立之后启动', () => {
    it('setActivePythonBridge 的登记早于 MCP Host 的 getActivePythonBridge 读取', () => {
      const registerIdx = indexOfOrFail(src, 'setActivePythonBridge(pythonBridge)');
      const mcpReadIdx = indexOfOrFail(src, 'const mcpBridge = getActivePythonBridge()');

      expect(registerIdx).toBeLessThan(mcpReadIdx);
    });

    it('MCP Host 在无桥接时不得打印成功状态', () => {
      const mcpReadIdx = indexOfOrFail(src, 'const mcpBridge = getActivePythonBridge()');
      // 截取 MCP 块（到下一个 process.stdout.write 之前）
      const rest = src.slice(mcpReadIdx);
      const blockEnd = rest.indexOf('process.stdout.write', 1);
      const block = blockEnd > 0 ? rest.slice(0, blockEnd) : rest;

      expect(block).toContain('startAllMcpServers');
      // 必须有 else 分支如实上报"未启动"，而不是无条件 ✅
      expect(block).toMatch(/未启动|⏭️/);
    });

    it('MCP Host 启动失败必须被捕获并留痕，不得中断启动', () => {
      const mcpReadIdx = indexOfOrFail(src, 'const mcpBridge = getActivePythonBridge()');
      const rest = src.slice(mcpReadIdx);
      const blockEnd = rest.indexOf('// W2', 1);
      const block = blockEnd > 0 ? rest.slice(0, blockEnd) : rest.slice(0, 900);

      expect(block).toContain('try {');
      expect(block).toContain('Logger.warn');
    });
  });

  describe('W2：TS Harness 不得无条件构建', () => {
    it('initHarness 调用被条件保护', () => {
      const callIdx = indexOfOrFail(src, 'await initHarness(core, memoryEngine, sceneRecognizer)');
      // 调用点之前 400 字符内必须出现门控判断
      const before = src.slice(Math.max(0, callIdx - 400), callIdx);

      expect(before).toContain('enableTsHarness');
      expect(before).toMatch(/if\s*\(\s*enableTsHarness\s*\)/);
    });

    it('门控判据是桥接的实际可用性，而非仅配置意图', () => {
      // 用 pythonBridge !== null 而非 usePythonBackend，
      // 保证"Python 配了但连不上"时 TS Harness 兜底仍然构建。
      expect(src).toContain('const pythonBackendLive = pythonBridge !== null');
      expect(src).toContain('const enableTsHarness = !pythonBackendLive || harnessForced');
    });

    it('提供 AGENT_HARNESS_ENABLE 逃生开关', () => {
      expect(src).toContain('AGENT_HARNESS_ENABLE');
      expect(src).toMatch(/harnessForced\s*=/);
    });

    it('门控判据的计算早于 initHarness 调用', () => {
      const gateIdx = indexOfOrFail(src, 'const enableTsHarness =');
      const callIdx = indexOfOrFail(src, 'await initHarness(core, memoryEngine, sceneRecognizer)');

      expect(gateIdx).toBeLessThan(callIdx);
    });

    it('harness 变量声明允许 null，网关初始化仍在其后', () => {
      const declIdx = indexOfOrFail(src, 'let harness:');
      const gatewayIdx = indexOfOrFail(src, 'await initGateway(core, harness)');

      expect(declIdx).toBeLessThan(gatewayIdx);
      expect(src).toMatch(/let harness:[^\n]*=\s*null/);
    });
  });

  describe('启动阶段整体顺序', () => {
    it('Python 桥接 → MCP Host → Harness → 网关 → IPC', () => {
      const bridgeIdx = indexOfOrFail(src, "process.stdout.write('  🐍 Python Agent 桥接... ')");
      const mcpIdx = indexOfOrFail(src, "process.stdout.write('  🔌 MCP Host... ')");
      const harnessIdx = indexOfOrFail(src, "process.stdout.write('  🏗️ Harness 框架... ')");
      const gatewayIdx = indexOfOrFail(src, "process.stdout.write('  📡 网关隔离... ')");
      const ipcIdx = indexOfOrFail(src, "process.stdout.write('  🔗 IPC 服务器... ')");

      expect(bridgeIdx).toBeLessThan(mcpIdx);
      expect(mcpIdx).toBeLessThan(harnessIdx);
      expect(harnessIdx).toBeLessThan(gatewayIdx);
      expect(gatewayIdx).toBeLessThan(ipcIdx);
    });
  });
});
