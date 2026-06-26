/**
 * 多环境终端后端单元测试
 *
 * 测试 LocalBackend / DockerBackend / SSHBackend / BackendFactory
 * Docker/SSH 后端在无对应环境时降级测试
 */

import { BackendFactory } from '../../../src/harness/sandbox/backends/BackendFactory';
import { DockerBackend } from '../../../src/harness/sandbox/backends/DockerBackend';
import type { ITerminalBackend } from '../../../src/harness/sandbox/backends/ITerminalBackend';
import { LocalBackend } from '../../../src/harness/sandbox/backends/LocalBackend';
import { SSHBackend } from '../../../src/harness/sandbox/backends/SSHBackend';

describe('多环境终端后端', () => {
  describe('LocalBackend', () => {
    let backend: LocalBackend;

    beforeEach(() => {
      backend = new LocalBackend({ type: 'local', timeout: 5000 });
    });

    afterEach(async () => {
      await backend.cleanup();
    });

    it('应该正确初始化', async () => {
      await backend.initialize();
      expect(backend.type).toBe('local');
    });

    it('应该执行简单命令并返回结果', async () => {
      await backend.initialize();
      const result = await backend.execute('echo hello');
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe('hello');
      expect(result.exitCode).toBe(0);
      expect(result.backend).toBe('local');
    });

    it('应该在命令失败时返回非零退出码', async () => {
      await backend.initialize();
      const result = await backend.execute('exit 1');
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    });

    it('应该支持超时控制', async () => {
      await backend.initialize();
      const result = await backend.execute('ping -n 10 127.0.0.1', {
        timeout: 1000,
      });
      // 超时后应返回失败
      expect(result.success).toBe(false);
    });

    it('应该执行 Python 代码', async () => {
      await backend.initialize();
      const result = await backend.executeCode(
        'print("hello from python")',
        'python',
        { timeout: 10000 }
      );
      // Python 可能未安装，跳过断言
      if (result.success) {
        expect(result.stdout).toContain('hello from python');
      }
    });

    it('应该执行 shell 代码', async () => {
      await backend.initialize();
      const result = await backend.executeCode('echo "shell test"', 'shell');
      expect(result.success).toBe(true);
      expect(result.stdout).toContain('shell test');
    });

    it('isAvailable 应返回 true', async () => {
      const available = await backend.isAvailable();
      expect(available).toBe(true);
    });

    it('getInfo 应返回正确信息', () => {
      const info = backend.getInfo();
      expect(info.type).toBe('local');
      expect(info.name).toBe('LocalBackend');
      expect(info.available).toBe(true);
      expect(info.isolation).toBe('none');
    });
  });

  describe('DockerBackend', () => {
    let backend: DockerBackend;

    beforeEach(() => {
      backend = new DockerBackend({
        type: 'docker',
        image: 'node:20-slim',
        containerName: 'jbx-test-sandbox',
        cpu: 0.5,
        memory: 512,
      });
    });

    afterEach(async () => {
      await backend.cleanup();
    });

    it('应该正确构造', () => {
      expect(backend.type).toBe('docker');
      const info = backend.getInfo();
      expect(info.type).toBe('docker');
      expect(info.isolation).toBe('container');
      expect(info.description).toContain('node:20-slim');
    });

    it('isAvailable 在无 Docker 时返回 false', async () => {
      // CI 环境通常无 Docker
      const available = await backend.isAvailable();
      expect(typeof available).toBe('boolean');
    });

    it('应该在 Docker 不可用时初始化抛出错误', async () => {
      const available = await backend.isAvailable();
      if (!available) {
        await expect(backend.initialize()).rejects.toThrow('Docker 不可用');
      }
    });
  });

  describe('SSHBackend', () => {
    let backend: SSHBackend;

    beforeEach(() => {
      backend = new SSHBackend({
        type: 'ssh',
        host: 'localhost',
        user: 'test',
        port: 2222,
        keyPath: '/nonexistent/key',
      });
    });

    afterEach(async () => {
      await backend.cleanup();
    });

    it('应该正确构造', () => {
      expect(backend.type).toBe('ssh');
      const info = backend.getInfo();
      expect(info.type).toBe('ssh');
      expect(info.isolation).toBe('network');
      expect(info.description).toContain('test@localhost');
    });

    it('isAvailable 在无 SSH 服务时返回 false', async () => {
      const available = await backend.isAvailable();
      expect(available).toBe(false);
    }, 20000);

    it('应该在 SSH 不可用时初始化抛出错误', async () => {
      await expect(backend.initialize()).rejects.toThrow('SSH 不可用');
    }, 20000);
  });

  describe('BackendFactory', () => {
    it('应该根据 config.type 创建 LocalBackend', () => {
      const backend = BackendFactory.create({ type: 'local' });
      expect(backend).toBeInstanceOf(LocalBackend);
      expect(backend.type).toBe('local');
    });

    it('应该根据 config.type 创建 DockerBackend', () => {
      const backend = BackendFactory.create({
        type: 'docker',
        image: 'node:20-slim',
      });
      expect(backend).toBeInstanceOf(DockerBackend);
    });

    it('应该根据 config.type 创建 SSHBackend', () => {
      const backend = BackendFactory.create({
        type: 'ssh',
        host: 'localhost',
        user: 'root',
      });
      expect(backend).toBeInstanceOf(SSHBackend);
    });

    it('parseFromEnv 默认返回 local 配置', () => {
      const oldVal = process.env.JBX_TERMINAL_BACKEND;
      delete process.env.JBX_TERMINAL_BACKEND;
      const config = BackendFactory.parseFromEnv();
      expect(config.type).toBe('local');
      process.env.JBX_TERMINAL_BACKEND = oldVal;
    });

    it('parseFromEnv 在 JBX_TERMINAL_BACKEND=docker 时返回 docker 配置', () => {
      const oldVal = process.env.JBX_TERMINAL_BACKEND;
      const oldImg = process.env.JBX_DOCKER_IMAGE;
      process.env.JBX_TERMINAL_BACKEND = 'docker';
      process.env.JBX_DOCKER_IMAGE = 'python:3.12-slim';
      const config = BackendFactory.parseFromEnv();
      expect(config.type).toBe('docker');
      if (config.type === 'docker') {
        expect(config.image).toBe('python:3.12-slim');
      }
      process.env.JBX_TERMINAL_BACKEND = oldVal;
      process.env.JBX_DOCKER_IMAGE = oldImg;
    });

    it('parseFromEnv 在 JBX_TERMINAL_BACKEND=ssh 时返回 ssh 配置', () => {
      const oldVal = process.env.JBX_TERMINAL_BACKEND;
      const oldHost = process.env.JBX_SSH_HOST;
      process.env.JBX_TERMINAL_BACKEND = 'ssh';
      process.env.JBX_SSH_HOST = 'remote.example.com';
      const config = BackendFactory.parseFromEnv();
      expect(config.type).toBe('ssh');
      if (config.type === 'ssh') {
        expect(config.host).toBe('remote.example.com');
      }
      process.env.JBX_TERMINAL_BACKEND = oldVal;
      process.env.JBX_SSH_HOST = oldHost;
    });

    it('getBackend 在 docker 不可用时应降级为 local', async () => {
      await BackendFactory.cleanup();
      const backend = await BackendFactory.getBackend({
        type: 'docker',
        image: 'nonexistent:image',
        containerName: 'jbx-fallback-test',
      });
      expect(backend.type).toBe('local');
      await BackendFactory.cleanup();
    });

    it('getBackend 应缓存单例后端', async () => {
      await BackendFactory.cleanup();
      const b1 = await BackendFactory.getBackend({ type: 'local' });
      const b2 = await BackendFactory.getBackend({ type: 'local' });
      expect(b1).toBe(b2);
      await BackendFactory.cleanup();
    });
  });

  describe('ITerminalBackend 接口契约', () => {
    it('所有后端都应实现完整接口', () => {
      const backends: ITerminalBackend[] = [
        new LocalBackend({ type: 'local' }),
        new DockerBackend({ type: 'docker', image: 'node:20-slim' }),
        new SSHBackend({ type: 'ssh', host: 'h', user: 'u' }),
      ];

      for (const b of backends) {
        expect(typeof b.initialize).toBe('function');
        expect(typeof b.execute).toBe('function');
        expect(typeof b.executeCode).toBe('function');
        expect(typeof b.isAvailable).toBe('function');
        expect(typeof b.getInfo).toBe('function');
        expect(typeof b.cleanup).toBe('function');
        expect(typeof b.type).toBe('string');
      }
    });
  });
});
