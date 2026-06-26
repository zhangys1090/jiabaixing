/**
 * 多环境终端后端系统
 *
 * 统一入口: BackendFactory → ITerminalBackend → BackendResult
 *
 * 支持后端:
 *   - local:  宿主机直接执行（无隔离）
 *   - docker: Docker 容器隔离执行
 *   - ssh:    SSH 远程执行（网络边界隔离）
 *
 * 配置方式:
 *   环境变量: JBX_TERMINAL_BACKEND=docker|ssh|local
 *   代码:     BackendFactory.getBackend(config)
 */

export { BackendFactory } from './BackendFactory';
export { DockerBackend } from './DockerBackend';
export type {
  BackendConfig,
  BackendInfo,
  BackendResult,
  BackendType,
  DockerBackendConfig,
  ExecuteOptions,
  ITerminalBackend,
  LocalBackendConfig,
  SSHBackendConfig,
} from './ITerminalBackend';
export { LocalBackend } from './LocalBackend';
export { SSHBackend } from './SSHBackend';
