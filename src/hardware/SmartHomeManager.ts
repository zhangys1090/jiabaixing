/**
 * 智能家居管理器
 * 统一的设备管理入口，支持多协议驱动
 */

import { Logger } from '../utils/Logger';
import {
  DeviceProtocol,
  ProtocolConfig,
  DiscoveredDevice,
  DeviceState,
  ProtocolResult,
} from './protocols/DeviceProtocol';
import { HomeAssistantProtocol } from './protocols/HomeAssistantProtocol';

/**
 * 设备操作结果
 */
export interface DeviceOperationResult {
  success: boolean;
  deviceId: string;
  command: string;
  data?: unknown;
  error?: string;
  timestamp: number;
}

/**
 * 智能家居管理器
 */
export class SmartHomeManager {
  private protocols: Map<string, DeviceProtocol> = new Map();
  private devices: Map<string, DiscoveredDevice> = new Map();
  private deviceStates: Map<string, DeviceState> = new Map();
  private initialized: boolean = false;

  /**
   * 初始化智能家居管理器
   */
  public async initialize(): Promise<void> {
    // 注册内置协议
    this.registerProtocol('homeassistant', new HomeAssistantProtocol());

    this.initialized = true;
    Logger.info('智能家居管理器初始化完成', 'SmartHomeManager');
  }

  /**
   * 注册协议驱动
   */
  public registerProtocol(name: string, protocol: DeviceProtocol): void {
    this.protocols.set(name, protocol);
    Logger.info(
      `注册协议驱动: ${name} v${protocol.version}`,
      'SmartHomeManager'
    );
  }

  /**
   * 连接协议
   */
  public async connectProtocol(
    name: string,
    config: ProtocolConfig
  ): Promise<ProtocolResult> {
    const protocol = this.protocols.get(name);
    if (!protocol) {
      return { success: false, error: `协议 ${name} 未注册` };
    }

    const result = await protocol.initialize(config);
    if (result.success) {
      Logger.info(`协议 ${name} 连接成功`, 'SmartHomeManager');
    }
    return result;
  }

  /**
   * 发现所有设备
   */
  public async discoverAll(): Promise<DiscoveredDevice[]> {
    const allDevices: DiscoveredDevice[] = [];

    for (const [name, protocol] of this.protocols.entries()) {
      try {
        const result = await protocol.discover();
        if (result.success && result.data) {
          const devices = result.data;
          for (const device of devices) {
            this.devices.set(device.id, device);
            allDevices.push(device);
          }
          Logger.info(
            `协议 ${name} 发现 ${devices.length} 个设备`,
            'SmartHomeManager'
          );
        }
      } catch (error) {
        Logger.warn(
          `协议 ${name} 设备发现失败: ${(error as Error).message}`,
          'SmartHomeManager'
        );
      }
    }

    return allDevices;
  }

  /**
   * 获取设备
   */
  public getDevice(deviceId: string): DiscoveredDevice | undefined {
    return this.devices.get(deviceId);
  }

  /**
   * 获取所有设备
   */
  public getAllDevices(): DiscoveredDevice[] {
    return Array.from(this.devices.values());
  }

  /**
   * 按类型获取设备
   */
  public getDevicesByType(type: string): DiscoveredDevice[] {
    return Array.from(this.devices.values()).filter((d) => d.type === type);
  }

  /**
   * 按协议获取设备
   */
  public getDevicesByProtocol(protocol: string): DiscoveredDevice[] {
    return Array.from(this.devices.values()).filter(
      (d) => d.protocol === protocol
    );
  }

  /**
   * 获取设备状态
   */
  public async getDeviceState(
    deviceId: string
  ): Promise<DeviceState | undefined> {
    const device = this.devices.get(deviceId);
    if (!device) return undefined;

    const protocol = this.protocols.get(device.protocol);
    if (!protocol) return undefined;

    const result = await protocol.getState(deviceId);
    if (result.success && result.data) {
      this.deviceStates.set(deviceId, result.data);
      return result.data;
    }

    return this.deviceStates.get(deviceId);
  }

  /**
   * 发送命令到设备
   */
  public async sendCommand(
    deviceId: string,
    command: string,
    params?: Record<string, unknown>
  ): Promise<DeviceOperationResult> {
    const device = this.devices.get(deviceId);
    if (!device) {
      return {
        success: false,
        deviceId,
        command,
        error: `设备 ${deviceId} 不存在`,
        timestamp: Date.now(),
      };
    }

    const protocol = this.protocols.get(device.protocol);
    if (!protocol) {
      return {
        success: false,
        deviceId,
        command,
        error: `协议 ${device.protocol} 未注册`,
        timestamp: Date.now(),
      };
    }

    const result = await protocol.sendCommand(deviceId, command, params);

    return {
      success: result.success,
      deviceId,
      command,
      data: result.data,
      error: result.error,
      timestamp: Date.now(),
    };
  }

  /**
   * 订阅设备状态变化
   */
  public async subscribe(
    deviceId: string,
    callback: (state: DeviceState) => void
  ): Promise<boolean> {
    const device = this.devices.get(deviceId);
    if (!device) return false;

    const protocol = this.protocols.get(device.protocol);
    if (!protocol) return false;

    const result = await protocol.subscribe(deviceId, (state) => {
      this.deviceStates.set(deviceId, state);
      callback(state);
    });

    return result.success;
  }

  /**
   * 批量控制设备
   */
  public async batchControl(
    operations: Array<{
      deviceId: string;
      command: string;
      params?: Record<string, unknown>;
    }>
  ): Promise<DeviceOperationResult[]> {
    const results: DeviceOperationResult[] = [];

    for (const op of operations) {
      const result = await this.sendCommand(op.deviceId, op.command, op.params);
      results.push(result);
    }

    return results;
  }

  /**
   * 场景执行
   */
  public async executeScene(
    sceneName: string,
    actions: Array<{
      deviceId: string;
      command: string;
      params?: Record<string, unknown>;
    }>
  ): Promise<{
    success: boolean;
    sceneName: string;
    results: DeviceOperationResult[];
    failedCount: number;
  }> {
    Logger.info(`执行场景: ${sceneName}`, 'SmartHomeManager');

    const results = await this.batchControl(actions);
    const failedCount = results.filter((r) => !r.success).length;

    return {
      success: failedCount === 0,
      sceneName,
      results,
      failedCount,
    };
  }

  /**
   * 断开协议连接
   */
  public async disconnectProtocol(name: string): Promise<void> {
    const protocol = this.protocols.get(name);
    if (protocol) {
      await protocol.shutdown();
      Logger.info(`协议 ${name} 已断开`, 'SmartHomeManager');
    }
  }

  /**
   * 关闭管理器
   */
  public async shutdown(): Promise<void> {
    for (const [name, protocol] of this.protocols.entries()) {
      try {
        await protocol.shutdown();
        Logger.info(`协议 ${name} 已关闭`, 'SmartHomeManager');
      } catch (error) {
        Logger.warn(
          `协议 ${name} 关闭失败: ${(error as Error).message}`,
          'SmartHomeManager'
        );
      }
    }

    this.protocols.clear();
    this.devices.clear();
    this.deviceStates.clear();
    this.initialized = false;

    Logger.info('智能家居管理器已关闭', 'SmartHomeManager');
  }

  /**
   * 获取统计信息
   */
  public getStats(): {
    protocolCount: number;
    deviceCount: number;
    onlineDeviceCount: number;
  } {
    const allDevices = Array.from(this.devices.values());
    return {
      protocolCount: this.protocols.size,
      deviceCount: allDevices.length,
      onlineDeviceCount: allDevices.filter((d) => d.online).length,
    };
  }
}
