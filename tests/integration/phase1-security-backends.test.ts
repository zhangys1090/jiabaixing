import { BackendFactory } from '../../src/harness/sandbox/backends/BackendFactory';
import { DaytonaBackend } from '../../src/harness/sandbox/backends/DaytonaBackend';
import { LocalBackend } from '../../src/harness/sandbox/backends/LocalBackend';
import { ModalBackend } from '../../src/harness/sandbox/backends/ModalBackend';
import { SingularityBackend } from '../../src/harness/sandbox/backends/SingularityBackend';
import { SecurityCore } from '../../src/security/SecurityCore';
import { ShellHooks } from '../../src/security/ShellHooks';
import { UrlSafetyChecker } from '../../src/security/UrlSafetyChecker';

jest.mock('child_process', () => ({
  exec: jest.fn(),
  execSync: jest.fn(),
  spawn: jest.fn(),
}));

describe('Phase 1 集成测试 - 安全四件套调用链路', () => {
  let securityCore: SecurityCore;

  beforeAll(() => {
    SecurityCore['instance'] = null;
    securityCore = SecurityCore.getInstance({
      enableNetworkGuard: false,
      enableUrlSafety: true,
      enableSslGuard: false,
      enableShellHooks: true,
    });
  });

  afterAll(() => {
    SecurityCore['instance'] = null;
  });

  describe('调用链路: SecurityCore → UrlSafetyChecker', () => {
    test('SecurityCore.checkUrlSafety 应委托给 UrlSafetyChecker', () => {
      const result = securityCore.checkUrlSafety('https://www.example.com');
      expect(result).toHaveProperty('safe');
      expect(result).toHaveProperty('riskLevel');
      expect(result).toHaveProperty('category');
      expect(result).toHaveProperty('reason');
    });

    test('应该检测到IP直连URL', () => {
      const result = securityCore.checkUrlSafety('http://192.168.1.1/admin');
      expect(result.safe).toBe(false);
      expect(result.riskLevel).toBe('medium');
    });

    test('应该检测到javascript:协议', () => {
      const result = securityCore.checkUrlSafety('javascript:alert(1)');
      expect(result.safe).toBe(false);
      expect(result.riskLevel).toBe('critical');
    });

    test('SecurityCore.getUrlSafety 应返回 UrlSafetyChecker 实例', () => {
      const urlSafety = securityCore.getUrlSafety();
      expect(urlSafety).toBeInstanceOf(UrlSafetyChecker);
    });

    test('UrlSafetyChecker 直接调用也应正常工作', () => {
      const urlSafety = UrlSafetyChecker.getInstance();
      const result = urlSafety.check('https://bit.ly/test');
      expect(result.safe).toBe(false);
      expect(result.category).toBe('短链接');
    });
  });

  describe('调用链路: SecurityCore → ShellHooks', () => {
    test('SecurityCore.getShellHooks 应返回 ShellHooks 实例', () => {
      const shellHooks = securityCore.getShellHooks();
      expect(shellHooks).toBeInstanceOf(ShellHooks);
    });

    test('SecurityCore.runShellPreHooks 应执行前置钩子', async () => {
      const result = await securityCore.runShellPreHooks({
        command: 'ls -la',
        backend: 'local',
        timestamp: Date.now(),
      });
      expect(result).toHaveProperty('proceed');
    });

    test('内置钩子应拦截危险命令', async () => {
      const result = await securityCore.runShellPreHooks({
        command: 'rm -rf /',
        backend: 'local',
        timestamp: Date.now(),
      });
      expect(result.proceed).toBe(false);
      expect(result.reason).toContain('危险命令拦截');
    });

    test('内置钩子应拦截路径遍历', async () => {
      const result = await securityCore.runShellPreHooks({
        command: 'cat ../../../etc/passwd',
        backend: 'local',
        timestamp: Date.now(),
      });
      expect(result.proceed).toBe(false);
      expect(result.reason).toContain('路径遍历');
    });

    test('正常命令应通过所有钩子', async () => {
      const result = await securityCore.runShellPreHooks({
        command: 'node -e "console.log(1)"',
        backend: 'local',
        timestamp: Date.now(),
      });
      expect(result.proceed).toBe(true);
    });

    test('SecurityCore.runShellPostHooks 应执行后置钩子', async () => {
      await expect(
        securityCore.runShellPostHooks(
          { command: 'ls', backend: 'local', timestamp: Date.now() },
          0,
          'output',
          ''
        )
      ).resolves.toBeUndefined();
    });
  });

  describe('调用链路: SecurityCore.healthCheck', () => {
    test('健康检查应包含新模块状态', () => {
      const health = securityCore.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.details).toHaveProperty('urlSafetyEnabled', true);
      expect(health.details).toHaveProperty('sslGuardEnabled', false);
      expect(health.details).toHaveProperty('shellHooksEnabled', true);
      expect(health.details).toHaveProperty('registeredShellHooks');
    });
  });

  describe('调用链路: SecurityCore → SslGuard', () => {
    test('SecurityCore.getSslGuard 应返回 SslGuard 实例', () => {
      const sslGuard = securityCore.getSslGuard();
      expect(sslGuard).toBeDefined();
      expect(typeof sslGuard.verifyUrl).toBe('function');
    });
  });

  describe('调用链路: SecurityCore → SensitiveDetector', () => {
    test('SecurityCore.checkSensitiveInfo 应检测敏感信息', () => {
      const result = securityCore.checkSensitiveInfo(
        '密码: mySecretPassword123'
      );
      expect(result.safe).toBe(false);
      expect(result.riskLevel).toBe('critical');
      expect(result.violations.length).toBeGreaterThan(0);
    });

    test('SecurityCore.checkDangerousCommand 应检测危险命令', () => {
      const result = securityCore.checkDangerousCommand('rm -rf /');
      expect(result.dangerous).toBe(true);
    });

    test('SecurityCore.sanitizeText 应脱敏文本', () => {
      const result = securityCore.sanitizeText(
        'API Key: sk-abc123def456ghi789jkl012mno345'
      );
      expect(result).toContain('[API密钥-已脱敏]');
      expect(result).not.toContain('sk-abc123def456ghi789jkl012mno345');
    });

    test('正常文本应返回安全', () => {
      const result = securityCore.checkSensitiveInfo('这是一段正常的文本');
      expect(result.safe).toBe(true);
      expect(result.riskLevel).toBe('none');
    });

    test('禁用时应跳过检测', async () => {
      SecurityCore['instance'] = null;
      const disabledCore = SecurityCore.getInstance({
        enableNetworkGuard: false,
        enableUrlSafety: false,
        enableSslGuard: false,
        enableShellHooks: false,
        enableSensitiveDetection: false,
      });
      const result = disabledCore.checkSensitiveInfo(
        '密码: mySecretPassword123'
      );
      expect(result.safe).toBe(true);
      expect(result.riskLevel).toBe('none');

      SecurityCore['instance'] = null;
      securityCore = SecurityCore.getInstance({
        enableNetworkGuard: false,
        enableUrlSafety: true,
        enableSslGuard: false,
        enableShellHooks: true,
        enableSensitiveDetection: true,
      });
    });
  });
});

describe('Phase 1 集成测试 - 终端后端扩展调用链路', () => {
  describe('BackendFactory.create 全类型覆盖', () => {
    test('应该创建所有6种后端类型', () => {
      const local = BackendFactory.create({ type: 'local' });
      expect(local).toBeInstanceOf(LocalBackend);

      const daytona = BackendFactory.create({
        type: 'daytona',
        workspaceName: 'test',
      });
      expect(daytona).toBeInstanceOf(DaytonaBackend);

      const modal = BackendFactory.create({ type: 'modal', appName: 'test' });
      expect(modal).toBeInstanceOf(ModalBackend);

      const singularity = BackendFactory.create({
        type: 'singularity',
        image: '/test.sif',
      });
      expect(singularity).toBeInstanceOf(SingularityBackend);
    });
  });

  describe('新后端 getInfo 一致性', () => {
    test('所有后端 getInfo 应返回完整信息', () => {
      const types: Array<{ type: string; extra: Record<string, unknown> }> = [
        { type: 'local', extra: {} },
        { type: 'daytona', extra: { workspaceName: 'test' } },
        { type: 'modal', extra: { appName: 'test' } },
        { type: 'singularity', extra: { image: '/test.sif' } },
      ];

      for (const { type, extra } of types) {
        const backend = BackendFactory.create({ type, ...extra } as any);
        const info = backend.getInfo();
        expect(info).toHaveProperty('type', type);
        expect(info).toHaveProperty('name');
        expect(info).toHaveProperty('available');
        expect(info).toHaveProperty('description');
        expect(info).toHaveProperty('persistentShell');
        expect(info).toHaveProperty('isolation');
      }
    });
  });
});

describe('Phase 1 集成测试 - initSecurity 调用链路', () => {
  test('initSecurity 应返回包含 securityCore 的结果', async () => {
    const { initSecurity } = require('../../src/server/init/initSecurity');
    const result = await initSecurity();

    expect(result).toHaveProperty('sovereigntyPipeline');
    expect(result).toHaveProperty('securityCore');
    expect(result.securityCore).toBeDefined();
    expect(typeof result.securityCore.checkUrlSafety).toBe('function');
    expect(typeof result.securityCore.runShellPreHooks).toBe('function');
    expect(typeof result.securityCore.healthCheck).toBe('function');
  });

  test('initSecurity 返回的 securityCore 应能正常工作', async () => {
    const { initSecurity } = require('../../src/server/init/initSecurity');
    const { securityCore } = await initSecurity();

    const health = securityCore.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.details.urlSafetyEnabled).toBe(true);
    expect(health.details.shellHooksEnabled).toBe(true);

    const urlResult = securityCore.checkUrlSafety('https://example.com');
    expect(urlResult).toHaveProperty('safe');

    const hookResult = await securityCore.runShellPreHooks({
      command: 'echo hello',
      backend: 'local',
      timestamp: Date.now(),
    });
    expect(hookResult.proceed).toBe(true);
  });
});
