import { Logger } from '../utils/Logger';
import { AudioVideoDeviceAccess } from './AudioVideoDeviceAccess';
import { DeviceDiscovery } from './DeviceDiscovery';
import {
  getDeviceSupportedCommands,
  getDeviceTypeDisplayName,
  isValidDeviceCommand,
} from './DeviceTypes';
import { LocalDeviceAccess } from './LocalDeviceAccess';
import { DeviceAdapter, SimulatedDeviceAdapter } from './DeviceAdapter';
import type { PythonAgentBridge } from '../ide/PythonAgentBridge';
import {
  Device,
  DeviceCommand,
  DeviceDiscoveryOptions,
  DeviceHealthAssessment,
  DeviceHealthIssue,
  DeviceHealthPrediction,
  DeviceReconnectionConfig,
  DeviceStatus,
} from './types';

export {
  Device,
  DeviceCommand,
  DeviceDiscoveryOptions,
  DeviceHealthAssessment,
  DeviceHealthIssue,
  DeviceHealthPrediction,
  DeviceReconnectionConfig,
  DeviceStatus,
} from './types';

/** W3：推送至 Python 环境感通道的设备遥测载荷。 */
export interface DeviceTelemetryPayload {
  device_id: string;
  name: string;
  kind: string;
  state: string;
  online: boolean;
  location?: string;
  batteryLevel?: number;
  signalStrength?: number;
  temperature?: number;
  humidity?: number;
  cpuUsage?: number;
  memoryUsage?: number;
  diskUsage?: number;
  networkSpeed?: number;
  uptime?: number;
  otherMetrics?: Record<string, unknown>;
}

export class DeviceManager {
  private initialized: boolean = false;
  private devices: Map<string, Device> = new Map();
  private deviceStatuses: Map<string, DeviceStatus> = new Map();
  private deviceCommands: Map<string, DeviceCommand> = new Map();
  private deviceHealthAssessments: Map<string, DeviceHealthAssessment> =
    new Map();
  private monitoringInterval: NodeJS.Timeout | undefined;
  private reconnectionTimers: Map<string, NodeJS.Timeout> = new Map();
  private localDeviceAccess: LocalDeviceAccess | null = null;
  private audioVideoDeviceAccess: AudioVideoDeviceAccess | null = null;
  private deviceDiscovery: DeviceDiscovery = DeviceDiscovery.getInstance();
  private reconnectionConfig: DeviceReconnectionConfig = {
    maxRetries: 5,
    retryInterval: 1000,
    timeout: 3000,
    backoffFactor: 2,
  };
  // 设备状态来源（W3）：默认模拟，可替换为真实 HTTP/MQTT 适配器
  private deviceAdapter: DeviceAdapter = new SimulatedDeviceAdapter();
  // W3：遥测桥（TS 仅入口/透传，状态推送至 Python 环境感通道）。未设置则不推送。
  private telemetryBridge: PythonAgentBridge | null = null;

  constructor() {}

  public async initialize(): Promise<void> {
    try {
      await this.initializeProtocolHandlers();

      this.localDeviceAccess = new LocalDeviceAccess();
      await this.localDeviceAccess.initialize();

      this.audioVideoDeviceAccess = new AudioVideoDeviceAccess();
      await this.audioVideoDeviceAccess.initialize();

      this.deviceDiscovery.setLocalDeviceAccess(this.localDeviceAccess);
      this.deviceDiscovery.setAudioVideoDeviceAccess(
        this.audioVideoDeviceAccess
      );

      this.initialized = true;
      this.deviceDiscovery.startDeviceDiscovery(async (options) => {
        return this.discoverDevices(options);
      });
    } catch (error) {
      Logger.error('❌ 设备管理器初始化失败', error as Error, 'DeviceManager');
      this.initialized = false;
      throw error;
    }
  }

  private async initializeProtocolHandlers(): Promise<void> {
    try {
    } catch (error) {
      Logger.error('❌ 协议处理器初始化失败', error as Error, 'DeviceManager');
      throw error;
    }
  }

  public async discoverDevices(
    options?: DeviceDiscoveryOptions
  ): Promise<Device[]> {
    this.ensureInitialized();

    try {
      const discoveredDevices =
        await this.deviceDiscovery.discoverDevices(options);

      for (const device of discoveredDevices) {
        const existingDevice = this.devices.get(device.id);
        if (existingDevice) {
          this.devices.set(device.id, {
            ...existingDevice,
            status: device.status,
            lastSeen: device.lastSeen,
            properties: { ...existingDevice.properties, ...device.properties },
            updatedAt: new Date(),
          });
        } else {
          this.devices.set(device.id, device);
        }
      }

      return discoveredDevices;
    } catch (error) {
      Logger.error('❌ 设备发现失败', error as Error, 'DeviceManager');
      return [];
    }
  }

  public getDevice(id: string): Device | null {
    this.ensureInitialized();
    return this.devices.get(id) || null;
  }

  public getDevices(): Device[] {
    this.ensureInitialized();
    return Array.from(this.devices.values());
  }

  public getDevicesByType(type: string): Device[] {
    this.ensureInitialized();
    return Array.from(this.devices.values()).filter(
      (device) => device.type === type
    );
  }

  public getDevicesByStatus(status: Device['status']): Device[] {
    this.ensureInitialized();
    return Array.from(this.devices.values()).filter(
      (device) => device.status === status
    );
  }

  public updateDeviceStatus(deviceId: string, status: DeviceStatus): void {
    this.ensureInitialized();

    const device = this.devices.get(deviceId);
    if (device) {
      this.devices.set(deviceId, {
        ...device,
        status: status.status,
        lastSeen: status.timestamp,
        updatedAt: new Date(),
      });

      this.deviceStatuses.set(deviceId, status);
    }
  }

  public getDeviceStatus(deviceId: string): DeviceStatus | null {
    this.ensureInitialized();
    return this.deviceStatuses.get(deviceId) || null;
  }

  public sendCommand(
    deviceId: string,
    command: string,
    parameters: Record<string, unknown>
  ): DeviceCommand {
    this.ensureInitialized();

    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`设备 ${deviceId} 不存在`);
    }

    if (!isValidDeviceCommand(device.type, command)) {
      throw new Error(`设备 ${device.name} 不支持命令 ${command}`);
    }

    const newCommand: DeviceCommand = {
      id: `command_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
      deviceId,
      command,
      parameters,
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    this.deviceCommands.set(newCommand.id, newCommand);

    void this.executeCommand(newCommand.id);

    return newCommand;
  }

  public getDeviceTypeDisplayName(deviceId: string): string {
    this.ensureInitialized();

    const device = this.devices.get(deviceId);
    if (!device) {
      return '未知设备';
    }

    return getDeviceTypeDisplayName(device.type);
  }

  public getDeviceSupportedCommands(deviceId: string): string[] {
    this.ensureInitialized();

    const device = this.devices.get(deviceId);
    if (!device) {
      return [];
    }

    return getDeviceSupportedCommands(device.type);
  }

  private async executeCommand(commandId: string): Promise<void> {
    const command = this.deviceCommands.get(commandId);
    if (!command) {
      return;
    }

    this.deviceCommands.set(commandId, {
      ...command,
      status: 'executing',
      updatedAt: new Date(),
    });

    try {
      const device = this.devices.get(command.deviceId);
      if (!device) {
        throw new Error(`设备 ${command.deviceId} 不存在`);
      }

      Logger.info(
        `📡 设备管理器：执行命令 ${command.command} 到设备 ${device.name} (${device.type})`,
        'DeviceManager'
      );

      let result;
      switch (device.type) {
        case 'light':
          result = await this.executeLightCommand(device, command);
          break;
        case 'outlet':
          result = await this.executeOutletCommand(device, command);
          break;
        case 'thermostat':
          result = await this.executeThermostatCommand(device, command);
          break;
        case 'lock':
          result = await this.executeLockCommand(device, command);
          break;
        case 'blind':
          result = await this.executeBlindCommand(device, command);
          break;
        case 'speaker':
          result = await this.executeSpeakerCommand(device, command);
          break;
        case 'camera':
          result = await this.executeCameraCommand(device, command);
          break;
        case 'tv':
          result = await this.executeTvCommand(device, command);
          break;
        case 'air conditioner':
          result = await this.executeAirConditionerCommand(device, command);
          break;
        default:
          throw new Error(`不支持的设备类型：${device.type}`);
      }

      this.updateDeviceProperties(device.id, result.properties);

      this.deviceCommands.set(commandId, {
        ...command,
        status: 'completed',
        result: {
          success: true,
          message: `命令 ${command.command} 执行成功`,
          properties: result.properties,
        },
        updatedAt: new Date(),
      });
    } catch (error) {
      this.deviceCommands.set(commandId, {
        ...command,
        status: 'failed',
        error: (error as Error).message,
        updatedAt: new Date(),
      });

      Logger.error(
        `❌ 设备管理器：命令 ${command.command} 执行失败`,
        error as Error,
        'DeviceManager'
      );
    }
  }

  private async executeLightCommand(
    device: Device,
    command: DeviceCommand
  ): Promise<{ properties: Record<string, unknown> }> {
    const properties = { ...device.properties };

    switch (command.command) {
      case 'power':
        properties.power = command.parameters.power;
        break;
      case 'brightness':
        properties.brightness = command.parameters.brightness;
        break;
      case 'color':
        properties.color = command.parameters.color;
        break;
      case 'colorTemperature':
        properties.colorTemperature = command.parameters.colorTemperature;
        break;
    }

    return { properties };
  }

  private async executeOutletCommand(
    device: Device,
    command: DeviceCommand
  ): Promise<{ properties: Record<string, unknown> }> {
    const properties = { ...device.properties };

    if (command.command === 'power') {
      properties.power = command.parameters.power;
    }

    return { properties };
  }

  private async executeThermostatCommand(
    device: Device,
    command: DeviceCommand
  ): Promise<{ properties: Record<string, unknown> }> {
    const properties = { ...device.properties };

    switch (command.command) {
      case 'setTemperature':
        properties.targetTemperature = command.parameters.temperature;
        break;
      case 'setMode':
        properties.mode = command.parameters.mode;
        break;
      case 'setFanMode':
        properties.fanMode = command.parameters.fanMode;
        break;
    }

    return { properties };
  }

  private async executeLockCommand(
    device: Device,
    command: DeviceCommand
  ): Promise<{ properties: Record<string, unknown> }> {
    const properties = { ...device.properties };

    if (command.command === 'lock') {
      properties.locked = true;
    } else if (command.command === 'unlock') {
      properties.locked = false;
    }

    return { properties };
  }

  private async executeBlindCommand(
    device: Device,
    command: DeviceCommand
  ): Promise<{ properties: Record<string, unknown> }> {
    const properties = { ...device.properties };

    switch (command.command) {
      case 'open':
        properties.position = 100;
        properties.power = true;
        break;
      case 'close':
        properties.position = 0;
        properties.power = true;
        break;
      case 'setPosition':
        properties.position = command.parameters.position;
        properties.power = true;
        break;
      case 'power':
        properties.power = command.parameters.power;
        break;
    }

    return { properties };
  }

  private async executeSpeakerCommand(
    device: Device,
    command: DeviceCommand
  ): Promise<{ properties: Record<string, unknown> }> {
    const properties = { ...device.properties };

    switch (command.command) {
      case 'power':
        properties.power = command.parameters.power;
        break;
      case 'volume':
        properties.volume = command.parameters.volume;
        break;
      case 'play':
        properties.playing = true;
        break;
      case 'pause':
        properties.playing = false;
        break;
      case 'stop':
        properties.playing = false;
        break;
    }

    return { properties };
  }

  private async executeCameraCommand(
    device: Device,
    command: DeviceCommand
  ): Promise<{ properties: Record<string, unknown> }> {
    const properties = { ...device.properties };

    switch (command.command) {
      case 'power':
        properties.power = command.parameters.power;
        break;
      case 'startStreaming':
        properties.streaming = true;
        break;
      case 'stopStreaming':
        properties.streaming = false;
        break;
      case 'takeSnapshot':
        properties.lastSnapshot = new Date().toISOString();
        break;
    }

    return { properties };
  }

  private async executeTvCommand(
    device: Device,
    command: DeviceCommand
  ): Promise<{ properties: Record<string, unknown> }> {
    const properties = { ...device.properties };

    switch (command.command) {
      case 'power':
        properties.power = command.parameters.power;
        break;
      case 'volume':
        properties.volume = command.parameters.volume;
        break;
      case 'channel':
        properties.channel = command.parameters.channel;
        break;
      case 'input':
        properties.input = command.parameters.input;
        break;
    }

    return { properties };
  }

  private async executeAirConditionerCommand(
    device: Device,
    command: DeviceCommand
  ): Promise<{ properties: Record<string, unknown> }> {
    const properties = { ...device.properties };

    switch (command.command) {
      case 'power':
        properties.power = command.parameters.power;
        break;
      case 'setTemperature':
        properties.temperature = command.parameters.temperature;
        break;
      case 'setMode':
        properties.mode = command.parameters.mode;
        break;
      case 'setFanSpeed':
        properties.fanSpeed = command.parameters.fanSpeed;
        break;
    }

    return { properties };
  }

  private updateDeviceProperties(
    deviceId: string,
    properties: Record<string, unknown>
  ): void {
    const device = this.devices.get(deviceId);
    if (device) {
      this.devices.set(deviceId, {
        ...device,
        properties: { ...device.properties, ...properties },
        updatedAt: new Date(),
      });
    }
  }

  public getCommand(commandId: string): DeviceCommand | null {
    this.ensureInitialized();
    return this.deviceCommands.get(commandId) || null;
  }

  public getDeviceCommands(deviceId: string): DeviceCommand[] {
    this.ensureInitialized();
    return Array.from(this.deviceCommands.values()).filter(
      (command) => command.deviceId === deviceId
    );
  }

  public startDeviceMonitoring(): void {
    this.ensureInitialized();

    this.monitoringInterval = setInterval(() => {
      for (const device of this.devices.values()) {
        // W3: 设备状态由注入的适配器提供（模拟或真实），不再硬编码随机
        const status: DeviceStatus = this.deviceAdapter.sampleStatus(device);

        this.updateDeviceStatus(device.id, status);

        this.assessDeviceHealth(device.id, status);

        if (status.status === 'offline') {
          this.attemptReconnection(device.id);
        }

        // 后台触发真实拉取（如为真实适配器），失败时降级到模拟
        void this.deviceAdapter.refresh(device);
      }

      // W3：把最新设备快照透传至 Python 环境感通道（无桥则跳过）
      if (this.telemetryBridge) {
        void this.publishDeviceTelemetry();
      }
    }, 30000);

    Logger.info('🔄 设备管理器：开始监控设备状态', 'DeviceManager');
  }

  /**
   * 注入设备状态适配器（W3）。可传入 HttpDeviceAdapter / MqttDeviceAdapter
   * 接入真实设备，未注入时默认使用 SimulatedDeviceAdapter。
   */
  public setDeviceAdapter(adapter: DeviceAdapter): void {
    this.deviceAdapter = adapter;
  }

  public getDeviceAdapterKind(): DeviceAdapter['kind'] {
    return this.deviceAdapter.kind;
  }

  /**
   * 设置遥测桥（W3）：把设备状态推送至 Python 端 ``DeviceSenseChannel``，
   * 经 ``POST /v1/devices/telemetry`` 灌入环境感通道（SensoryFusion）。
   * 仅作入口/透传，不在此做融合逻辑（AGENTS.md §0.1）。
   */
  public setTelemetryBridge(bridge: PythonAgentBridge): void {
    this.telemetryBridge = bridge;
  }

  /**
   * 构造设备遥测载荷，供 Python ``POST /v1/devices/telemetry`` 消费。
   * 字段对齐 python/agent/perception/device_sense.py::DeviceStatus.from_dict。
   */
  public buildDeviceTelemetry(): DeviceTelemetryPayload[] {
    const payloads: DeviceTelemetryPayload[] = [];
    for (const device of this.devices.values()) {
      const status = this.deviceStatuses.get(device.id);
      if (!status) {
        continue;
      }
      const state = status.status;
      const payload: DeviceTelemetryPayload = {
        device_id: device.id,
        name: device.name,
        kind: device.type,
        state,
        online: state !== 'offline' && state !== 'error',
        location: this.resolveDeviceLocation(device),
        // 透传业务指标，便于 Python 决策复用
        batteryLevel: status.batteryLevel,
        signalStrength: status.signalStrength,
        temperature: status.temperature,
        humidity: status.humidity,
        cpuUsage: status.cpuUsage,
        memoryUsage: status.memoryUsage,
        diskUsage: status.diskUsage,
        networkSpeed: status.networkSpeed,
        uptime: status.uptime,
        otherMetrics: status.otherMetrics,
      };
      payloads.push(payload);
    }
    return payloads;
  }

  /**
   * 推送当前设备状态至 Python 环境感通道。返回成功写入的样本数（-1 表示未配置桥）。
   */
  public async publishDeviceTelemetry(): Promise<number> {
    if (!this.telemetryBridge) {
      return -1;
    }
    const payloads = this.buildDeviceTelemetry();
    if (payloads.length === 0) {
      return 0;
    }
    const result = await this.telemetryBridge.postDeviceTelemetry(payloads);
    return result.ingested ?? payloads.length;
  }

  private resolveDeviceLocation(device: Device): string | undefined {
    const loc =
      (device as unknown as { location?: string }).location ??
      (device.properties as Record<string, unknown> | undefined)?.['location'];
    return typeof loc === 'string' ? loc : undefined;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('设备管理器未初始化！请先调用initialize方法。');
    }
  }

  public assessDeviceHealth(
    deviceId: string,
    status: DeviceStatus
  ): DeviceHealthAssessment {
    const device = this.devices.get(deviceId);
    if (!device) {
      throw new Error(`设备 ${deviceId} 不存在`);
    }

    let healthScore = 100;
    const issues: DeviceHealthIssue[] = [];
    const recommendations: string[] = [];
    const predictions: DeviceHealthPrediction[] = [];

    if (status.batteryLevel !== undefined && status.batteryLevel < 20) {
      healthScore -= 20;
      issues.push({
        id: `issue_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        type: 'battery',
        severity: 'high',
        description: '电池电量低',
        timestamp: new Date(),
        possibleCauses: ['电池老化', '使用频繁'],
        suggestedActions: ['更换电池', '减少使用频率'],
      });
      recommendations.push('建议及时更换电池');
    }

    if (status.signalStrength !== undefined && status.signalStrength < 30) {
      healthScore -= 15;
      issues.push({
        id: `issue_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        type: 'signal',
        severity: 'medium',
        description: '信号强度弱',
        timestamp: new Date(),
        possibleCauses: ['距离过远', '障碍物遮挡'],
        suggestedActions: ['移近设备', '移除障碍物'],
      });
      recommendations.push('建议改善设备放置位置以增强信号');
    }

    if (status.cpuUsage !== undefined && status.cpuUsage > 80) {
      healthScore -= 10;
      issues.push({
        id: `issue_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        type: 'cpu',
        severity: 'medium',
        description: 'CPU使用率高',
        timestamp: new Date(),
        possibleCauses: ['任务过多', '系统负载高'],
        suggestedActions: ['减少运行任务', '重启设备'],
      });
      recommendations.push('建议减少设备负载');
    }

    if (status.memoryUsage !== undefined && status.memoryUsage > 85) {
      healthScore -= 10;
      issues.push({
        id: `issue_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        type: 'memory',
        severity: 'medium',
        description: '内存使用率高',
        timestamp: new Date(),
        possibleCauses: ['内存不足', '内存泄漏'],
        suggestedActions: ['清理内存', '重启设备'],
      });
      recommendations.push('建议清理设备内存');
    }

    if (status.diskUsage !== undefined && status.diskUsage > 90) {
      healthScore -= 15;
      issues.push({
        id: `issue_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        type: 'disk',
        severity: 'high',
        description: '磁盘使用率高',
        timestamp: new Date(),
        possibleCauses: ['存储空间不足', '垃圾文件过多'],
        suggestedActions: ['清理磁盘空间', '删除不必要的文件'],
      });
      recommendations.push('建议清理磁盘空间');
    }

    if (status.batteryLevel !== undefined && status.batteryLevel < 30) {
      predictions.push({
        id: `prediction_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
        type: 'battery',
        probability: 85,
        timestamp: new Date(),
        description: '预计电池将在近期耗尽',
        suggestedActions: ['立即更换电池'],
        expectedTime: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    }

    let healthStatus: 'excellent' | 'good' | 'fair' | 'poor';
    if (healthScore >= 90) {
      healthStatus = 'excellent';
    } else if (healthScore >= 70) {
      healthStatus = 'good';
    } else if (healthScore >= 50) {
      healthStatus = 'fair';
    } else {
      healthStatus = 'poor';
    }

    const assessment: DeviceHealthAssessment = {
      deviceId,
      timestamp: new Date(),
      healthScore: Math.max(0, healthScore),
      status: healthStatus,
      issues,
      recommendations,
      predictions,
    };

    this.deviceHealthAssessments.set(deviceId, assessment);
    return assessment;
  }

  public getDeviceHealthAssessment(
    deviceId: string
  ): DeviceHealthAssessment | null {
    this.ensureInitialized();
    return this.deviceHealthAssessments.get(deviceId) || null;
  }

  public attemptReconnection(deviceId: string): void {
    const device = this.devices.get(deviceId);
    if (!device) {
      return;
    }

    if (this.reconnectionTimers.has(deviceId)) {
      return;
    }

    let retryCount = 0;
    const reconnect = () => {
      retryCount++;

      const isReconnected = this.simulateReconnection(device);

      if (isReconnected) {
        const status: DeviceStatus = {
          deviceId: device.id,
          timestamp: new Date(),
          status: 'online',
          batteryLevel: Math.floor(Math.random() * 100),
          signalStrength: Math.floor(Math.random() * 100),
          temperature: 20 + Math.random() * 10,
          humidity: 40 + Math.random() * 20,
          otherMetrics: {
            uptime: Math.floor(Math.random() * 86400),
          },
        };
        this.updateDeviceStatus(device.id, status);

        if (this.reconnectionTimers.has(deviceId)) {
          clearInterval(this.reconnectionTimers.get(deviceId)!);
          this.reconnectionTimers.delete(deviceId);
        }
      } else if (retryCount >= this.reconnectionConfig.maxRetries) {
        if (this.reconnectionTimers.has(deviceId)) {
          clearInterval(this.reconnectionTimers.get(deviceId)!);
          this.reconnectionTimers.delete(deviceId);
        }
      }
    };

    reconnect();

    const timer = setInterval(reconnect, this.reconnectionConfig.retryInterval);
    this.reconnectionTimers.set(deviceId, timer);
  }

  private simulateReconnection(_device: Device): boolean {
    return Math.random() < 0.5;
  }

  public handleDeviceError(deviceId: string, error: Error): void {
    const device = this.devices.get(deviceId);
    if (!device) {
      return;
    }

    Logger.error(
      `❌ 设备管理器：设备 ${device.name} 发生错误`,
      error as Error,
      'DeviceManager'
    );

    const currentStatus = this.deviceStatuses.get(deviceId);

    const status: DeviceStatus = {
      deviceId: device.id,
      timestamp: new Date(),
      status: 'error',
      batteryLevel: currentStatus?.batteryLevel,
      signalStrength: currentStatus?.signalStrength,
      temperature: currentStatus?.temperature,
      humidity: currentStatus?.humidity,
      cpuUsage: currentStatus?.cpuUsage,
      memoryUsage: currentStatus?.memoryUsage,
      diskUsage: currentStatus?.diskUsage,
      networkSpeed: currentStatus?.networkSpeed,
      uptime: currentStatus?.uptime,
      otherMetrics: {
        ...currentStatus?.otherMetrics,
        error: error.message,
      },
    };
    this.updateDeviceStatus(device.id, status);

    this.attemptReconnection(device.id);
  }

  public async shutdown(): Promise<void> {
    Logger.info('🔌 设备管理器：关闭中...', 'DeviceManager');

    this.deviceDiscovery.stopDeviceDiscovery();

    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }

    for (const [, timer] of this.reconnectionTimers) {
      clearInterval(timer);
    }
    this.reconnectionTimers.clear();

    if (this.localDeviceAccess) {
      await this.localDeviceAccess.shutdown();
    }

    if (this.audioVideoDeviceAccess) {
      await this.audioVideoDeviceAccess.shutdown();
    }

    this.initialized = false;
    this.devices.clear();
    this.deviceStatuses.clear();
    this.deviceCommands.clear();
    this.deviceHealthAssessments.clear();
  }
}
