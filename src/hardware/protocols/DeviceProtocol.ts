/**
 * 设备协议抽象接口
 * 定义所有硬件协议必须实现的标准接口
 */

/**
 * 协议配置
 */
export interface ProtocolConfig {
  type: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  token?: string;
  timeout?: number;
  [key: string]: unknown;
}

/**
 * 设备发现结果
 */
export interface DiscoveredDevice {
  id: string;
  name: string;
  type: string;
  protocol: string;
  address: string;
  properties: Record<string, unknown>;
  capabilities: string[];
  online: boolean;
}

/**
 * 设备状态
 */
export interface DeviceState {
  online: boolean;
  power?: boolean;
  brightness?: number;
  temperature?: number;
  [key: string]: unknown;
}

/**
 * 协议操作结果
 */
export interface ProtocolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * 设备协议接口
 */
export interface DeviceProtocol {
  readonly name: string;
  readonly version: string;

  /**
   * 初始化协议连接
   */
  initialize(config: ProtocolConfig): Promise<ProtocolResult>;

  /**
   * 发现设备
   */
  discover(): Promise<ProtocolResult<DiscoveredDevice[]>>;

  /**
   * 获取设备状态
   */
  getState(deviceId: string): Promise<ProtocolResult<DeviceState>>;

  /**
   * 发送命令到设备
   */
  sendCommand(
    deviceId: string,
    command: string,
    params?: Record<string, unknown>
  ): Promise<ProtocolResult>;

  /**
   * 订阅设备状态变化
   */
  subscribe(
    deviceId: string,
    callback: (state: DeviceState) => void
  ): Promise<ProtocolResult>;

  /**
   * 取消订阅
   */
  unsubscribe(deviceId: string): Promise<ProtocolResult>;

  /**
   * 关闭协议连接
   */
  shutdown(): Promise<ProtocolResult>;
}
