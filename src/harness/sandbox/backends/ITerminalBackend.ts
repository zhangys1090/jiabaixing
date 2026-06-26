/**
 * 多环境终端后端统一接口
 *
 * 设计参考: Hermes Agent tools/environments/ 多后端架构
 * 支持后端: local | docker | ssh (后续可扩展 modal | daytona | singularity)
 *
 * 数据流: BackendFactory.create(config) → ITerminalBackend.execute() → BackendResult
 */

/** 后端类型 */
export type BackendType =
  | 'local'
  | 'docker'
  | 'ssh'
  | 'daytona'
  | 'modal'
  | 'singularity';

/** 执行选项 */
export interface ExecuteOptions {
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 工作目录 */
  cwd?: string;
  /** 环境变量 */
  env?: Record<string, string>;
  /** 最大输出缓冲区（字节） */
  maxBuffer?: number;
}

/** 后端执行结果 */
export interface BackendResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  /** 后端名称（用于日志追踪） */
  backend: string;
  /** 执行元数据 */
  metadata?: Record<string, unknown>;
}

/** 后端信息 */
export interface BackendInfo {
  type: BackendType;
  name: string;
  available: boolean;
  /** 后端特性描述 */
  description: string;
  /** 是否支持持久化 shell（跨命令保持状态） */
  persistentShell: boolean;
  /** 隔离级别 */
  isolation: 'none' | 'process' | 'container' | 'network';
}

/** 后端配置（联合类型，按 type 区分） */
export interface BaseBackendConfig {
  type: BackendType;
  /** 默认超时（毫秒） */
  timeout?: number;
  /** 默认工作目录 */
  cwd?: string;
  /** 是否启用持久化 shell */
  persistentShell?: boolean;
}

export interface LocalBackendConfig extends BaseBackendConfig {
  type: 'local';
}

export interface DockerBackendConfig extends BaseBackendConfig {
  type: 'docker';
  /** 容器镜像 */
  image: string;
  /** 容器名称（持久容器复用） */
  containerName?: string;
  /** CPU 核心数限制 */
  cpu?: number;
  /** 内存限制（MB） */
  memory?: number;
  /** 挂载宿主目录到 /workspace */
  mountCwd?: boolean;
  /** 额外卷挂载 */
  volumes?: string[];
  /** 转发到容器的环境变量名 */
  forwardEnv?: string[];
}

export interface SSHBackendConfig extends BaseBackendConfig {
  type: 'ssh';
  /** SSH 主机 */
  host: string;
  /** SSH 用户 */
  user: string;
  /** SSH 端口（默认 22） */
  port?: number;
  /** SSH 私钥路径 */
  keyPath?: string;
  /** SSH 密码（不推荐，优先用密钥） */
  password?: string;
}

export interface DaytonaBackendConfig extends BaseBackendConfig {
  type: 'daytona';
  /** Daytona API 端点 */
  apiUrl?: string;
  /** 工作区名称 */
  workspaceName?: string;
  /** 目标模板 */
  template?: string;
}

export interface ModalBackendConfig extends BaseBackendConfig {
  type: 'modal';
  /** Modal App 名称 */
  appName?: string;
  /** GPU 类型 */
  gpu?: 'T4' | 'A10G' | 'A100' | 'H100';
  /** CPU 核心数 */
  cpu?: number;
  /** 内存（MB） */
  memory?: number;
  /** 超时秒数（Modal 侧） */
  modalTimeout?: number;
}

export interface SingularityBackendConfig extends BaseBackendConfig {
  type: 'singularity';
  /** SIF 镜像路径 */
  image: string;
  /** 是否使用 --fakeroot */
  fakeroot?: boolean;
  /** 绑定挂载 */
  binds?: string[];
  /** NVIDIA 支持 */
  nvidia?: boolean;
}

export type BackendConfig =
  | LocalBackendConfig
  | DockerBackendConfig
  | SSHBackendConfig
  | DaytonaBackendConfig
  | ModalBackendConfig
  | SingularityBackendConfig;

/**
 * 终端后端统一接口
 *
 * 所有后端实现此接口，由 BackendFactory 根据配置创建
 */
export interface ITerminalBackend {
  /** 后端类型标识 */
  readonly type: BackendType;

  /** 初始化后端（如启动容器、建立 SSH 连接） */
  initialize(): Promise<void>;

  /** 执行 shell 命令 */
  execute(command: string, options?: ExecuteOptions): Promise<BackendResult>;

  /** 执行代码（按语言路由到 shell/python 解释器） */
  executeCode(
    code: string,
    language: 'javascript' | 'python' | 'shell',
    options?: ExecuteOptions
  ): Promise<BackendResult>;

  /** 检查后端是否可用（如 docker 是否安装、ssh 是否可达） */
  isAvailable(): Promise<boolean>;

  /** 获取后端信息 */
  getInfo(): BackendInfo;

  /** 清理资源（如停止容器、关闭 SSH 连接） */
  cleanup(): Promise<void>;
}
