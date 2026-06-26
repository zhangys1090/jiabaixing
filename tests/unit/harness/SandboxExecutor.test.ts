/**
 * SandboxExecutor 单元测试
 * 测试沙箱执行器的安全代码执行功能
 */
import { SandboxExecutor } from '../../../src/harness/sandbox/SandboxExecutor';

describe('SandboxExecutor', () => {
  let executor: SandboxExecutor;

  beforeEach(() => {
    executor = new SandboxExecutor();
  });

  describe('初始化与构造', () => {
    it('应该使用默认配置正确初始化', () => {
      expect(executor).toBeInstanceOf(SandboxExecutor);
      const config = executor.getConfig();
      expect(config.securityLevel).toBe('low');
      expect(config.timeoutMs).toBe(30000);
      expect(config.maxMemoryMb).toBe(256);
      expect(config.networkPolicy).toBe('deny');
    });

    it('应该接受部分自定义配置', () => {
      const custom = new SandboxExecutor({
        securityLevel: 'high',
        timeoutMs: 5000,
      });
      const config = custom.getConfig();
      expect(config.securityLevel).toBe('high');
      expect(config.timeoutMs).toBe(5000);
      // 未覆盖的应保留默认值
      expect(config.maxMemoryMb).toBe(256);
    });
  });

  describe('checkToolPermission', () => {
    it('应该允许低风险工具在任何安全级别下执行', () => {
      const result = executor.checkToolPermission('file_read', {});
      expect(result.allowed).toBe(true);
    });

    it('应该在高安全级别下拒绝高风险工具', () => {
      const highSecurityExecutor = new SandboxExecutor({
        securityLevel: 'high',
      });
      const result = highSecurityExecutor.checkToolPermission('shell_exec', {});
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('shell_exec');
      expect(result.riskLevel).toBe('critical');
    });

    it('应该在安全级别为 low 时允许高风险工具', () => {
      const result = executor.checkToolPermission('shell_exec', {});
      expect(result.allowed).toBe(true);
    });
  });

  describe('updateConfig', () => {
    it('应该能更新配置', () => {
      executor.updateConfig({ securityLevel: 'critical' });
      expect(executor.getConfig().securityLevel).toBe('critical');
    });
  });

  describe('executeCode - 安全检查', () => {
    it('应该拒绝包含 require 调用的代码', async () => {
      const result = await executor.executeCode('const fs = require("fs")');
      expect(result.success).toBe(false);
      expect(result.error).toContain('安全检查失败');
      expect(result.securityViolations).toBeDefined();
      expect(result.securityViolations!.length).toBeGreaterThan(0);
    });

    it('应该拒绝包含 eval 的代码', async () => {
      const result = await executor.executeCode('eval("2+2")');
      expect(result.success).toBe(false);
      expect(result.error).toContain('安全检查失败');
    });

    it('应该拒绝包含 child_process 的代码', async () => {
      const result = await executor.executeCode('child_process.exec("ls")');
      expect(result.success).toBe(false);
    });

    it('应该拒绝文件系统操作', async () => {
      const result = await executor.executeCode(
        'fs.readFileSync("/etc/passwd")'
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('executeCode - 安全代码执行', () => {
    it('应该执行简单的数学表达式', async () => {
      const result = await executor.executeCode('return 1 + 2;');
      expect(result.success).toBe(true);
      expect(result.output).toBe(3);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('应该执行字符串操作', async () => {
      const result = await executor.executeCode(
        'const msg = "hello, sandbox"; return msg.toUpperCase();'
      );
      expect(result.success).toBe(true);
      expect(result.output).toBe('HELLO, SANDBOX');
    });

    it('应该支持 console 日志', async () => {
      const code = `
        console.log("test message");
        return "done";
      `;
      const result = await executor.executeCode(code);
      expect(result.success).toBe(true);
      expect(result.output).toBe('done');
      expect(result.logs).toBeDefined();
      expect(result.logs!.length).toBeGreaterThanOrEqual(1);
    });

    it('应该支持 async/await 代码', async () => {
      const code = `
        const result = await Promise.resolve(42);
        return result;
      `;
      const result = await executor.executeCode(code);
      expect(result.success).toBe(true);
      expect(result.output).toBe(42);
    });
  });

  describe('executeCode - 错误处理', () => {
    it('应该捕获运行时错误', async () => {
      const result = await executor.executeCode(
        'throw new Error("test error")'
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('test error');
    });

    it('应该捕获语法错误', async () => {
      const result = await executor.executeCode('invalid syntax {{{');
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
