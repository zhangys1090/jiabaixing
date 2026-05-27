import { Logger } from '../utils/Logger';
import { AudioVideoDeviceAccess } from './AudioVideoDeviceAccess';
import { DeviceDiscovery } from './DeviceDiscovery';
import {
  getDeviceSupportedCommands,
  getDeviceTypeDisplayName,
  isValidDeviceCommand,
} from './DeviceTypes';
import { LocalDeviceAccess } from './LocalDeviceAccess';
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

  constructor() {}

  public async initialize(): Promise<void> {
    try {
      await this.initializeProtocolHandlers();

      this.localDeviceAccess = new LocalDeviceAccess();
      await this.localDeviceAccess.initialize();

      this.audioVideoDeviceAccess = new AudioVideoDeviceAccess();
      await this.audioVideoDeviceAccess.initialize();

      this.deviceDiscovery.setLocalDeviceAccess(this.localDeviceAccess);
      this.deviceDiscovery.setAudioVideoDeviceAccess(this.audioVideoDeviceAccess);

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
      const discoveredDevices = await this.deviceDiscovery.discoverDevices(options);

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

    this.executeCommand(newCommand.id);

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
        const status: DeviceStatus = {
          deviceId: device.id,
          timestamp: new Date(),
          status: this.simulateDeviceStatus(device),
          batteryLevel: Math.floor(Math.random() * 100),
          signalStrength: Math.floor(Math.random() * 100),
          temperature: 20 + Math.random() * 10,
          humidity: 40 + Math.random() * 20,
          cpuUsage: Math.floor(Math.random() * 100),
          memoryUsage: Math.floor(Math.random() * 100),
          diskUsage: Math.floor(Math.random() * 100),
          networkSpeed: Math.floor(Math.random() * 1000),
          uptime: Math.floor(Math.random() * 86400),
          otherMetrics: {
            uptime: Math.floor(Math.random() * 86400),
            responseTime: Math.random() * 1000,
          },
        };

        this.updateDeviceStatus(device.id, status);

        this.assessDeviceHealth(device.id, status);

        if (status.status === 'offline') {
          this.attemptReconnection(device.id);
        }
      }
    }, 30000);

    Logger.info('🔄 设备管理器：开始监控设备状态', 'DeviceManager');
  }

  private simulateDeviceStatus(device: Device): Device['status'] {
    const random = Math.random();
    if (random < 0.1) {
      return 'offline';
    } else if (random < 0.2) {
      return 'warning';
    } else if (random < 0.25) {
      return 'error';
    } else {
      return 'online';
    }
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

  private simulateReconnection(device: Device): boolean {
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

    for (const [deviceId, timer] of this.reconnectionTimers) {
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
