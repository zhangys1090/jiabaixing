/**
 * 终端后端工厂
 *
 * 根据配置创建对应的后端实例，支持运行时切换。
 * 配置来源: ~/.hermes/config.yaml → terminal.backend
 */

import { Logger } from '../../../utils/Logger';
import { DaytonaBackend } from './DaytonaBackend';
import { DockerBackend } from './DockerBackend';
import type { BackendConfig, ITerminalBackend } from './ITerminalBackend';
import { LocalBackend } from './LocalBackend';
import { ModalBackend } from './ModalBackend';
import { SingularityBackend } from './SingularityBackend';
import { SSHBackend } from './SSHBackend';

export class BackendFactory {
  private static currentBackend: ITerminalBackend | null = null;
  private static currentConfig: BackendConfig | null = null;

  /**
   * 创建后端实例
   */
  static create(config: BackendConfig): ITerminalBackend {
    switch (config.type) {
      case 'local':
        return new LocalBackend(config);
      case 'docker':
        return new DockerBackend(config);
      case 'ssh':
        return new SSHBackend(config);
      case 'daytona':
        return new DaytonaBackend(config);
      case 'modal':
        return new ModalBackend(config);
      case 'singularity':
        return new SingularityBackend(config);
      default:
        Logger.warn(
          `未知后端类型 ${(config as { type: string }).type}，降级为 local`,
          'BackendFactory'
        );
        return new LocalBackend({ type: 'local' });
    }
  }

  /**
   * 获取/创建单例后端
   */
  static async getBackend(config: BackendConfig): Promise<ITerminalBackend> {
    // 配置变更时重建
    if (
      this.currentBackend &&
      this.currentConfig &&
      JSON.stringify(this.currentConfig) === JSON.stringify(config)
    ) {
      return this.currentBackend;
    }

    // 清理旧后端
    if (this.currentBackend) {
      await this.currentBackend.cleanup();
    }

    this.currentBackend = this.create(config);
    this.currentConfig = config;

    try {
      await this.currentBackend.initialize();
    } catch (err) {
      Logger.error(
        `后端初始化失败，降级为 local: ${(err as Error).message}`,
        err as Error,
        'BackendFactory'
      );
      await this.currentBackend.cleanup();
      this.currentBackend = new LocalBackend({ type: 'local' });
      await this.currentBackend.initialize();
      this.currentConfig = { type: 'local' };
    }

    return this.currentBackend;
  }

  /**
   * 从环境变量/配置文件解析后端配置
   */
  static parseFromEnv(): BackendConfig {
    const type = (process.env.JBX_TERMINAL_BACKEND || 'local').toLowerCase();

    switch (type) {
      case 'docker':
        return {
          type: 'docker',
          image: process.env.JBX_DOCKER_IMAGE || 'node:20-slim',
          containerName:
            process.env.JBX_DOCKER_CONTAINER || 'jiabaixing-sandbox',
          cpu: Number(process.env.JBX_DOCKER_CPU) || 1,
          memory: Number(process.env.JBX_DOCKER_MEMORY) || 2048,
          mountCwd: process.env.JBX_DOCKER_MOUNT_CWD === 'true',
        };

      case 'ssh':
        return {
          type: 'ssh',
          host: process.env.JBX_SSH_HOST || 'localhost',
          user: process.env.JBX_SSH_USER || 'root',
          port: Number(process.env.JBX_SSH_PORT) || 22,
          keyPath: process.env.JBX_SSH_KEY_PATH,
        };

      case 'daytona':
        return {
          type: 'daytona',
          apiUrl: process.env.JBX_DAYTONA_API_URL,
          workspaceName: process.env.JBX_DAYTONA_WORKSPACE || 'jiabaixing',
          template: process.env.JBX_DAYTONA_TEMPLATE,
        };

      case 'modal':
        return {
          type: 'modal',
          appName: process.env.JBX_MODAL_APP || 'jiabaixing-exec',
          gpu: process.env.JBX_MODAL_GPU as
            | 'T4'
            | 'A10G'
            | 'A100'
            | 'H100'
            | undefined,
          cpu: Number(process.env.JBX_MODAL_CPU) || undefined,
          memory: Number(process.env.JBX_MODAL_MEMORY) || undefined,
          modalTimeout: Number(process.env.JBX_MODAL_TIMEOUT) || 300,
        };

      case 'singularity':
        return {
          type: 'singularity',
          image:
            process.env.JBX_SINGULARITY_IMAGE ||
            '/srv/singularity/jiabaixing.sif',
          fakeroot: process.env.JBX_SINGULARITY_FAKEROOT === 'true',
          binds: process.env.JBX_SINGULARITY_BINDS?.split(',') || [],
          nvidia: process.env.JBX_SINGULARITY_NVIDIA === 'true',
        };

      case 'local':
      default:
        return { type: 'local' };
    }
  }

  /**
   * 清理当前后端
   */
  static async cleanup(): Promise<void> {
    if (this.currentBackend) {
      await this.currentBackend.cleanup();
      this.currentBackend = null;
      this.currentConfig = null;
    }
  }
}
