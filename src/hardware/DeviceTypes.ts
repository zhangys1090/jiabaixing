/**
 * 设备类型库
 * 定义不同类型设备的标准接口和控制方法
 */

export type DeviceType =
  | 'light' // 照明设备
  | 'outlet' // 插座
  | 'sensor' // 传感器
  | 'thermostat' // 恒温器
  | 'lock' // 门锁
  | 'blind' // 窗帘
  | 'speaker' // 音箱
  | 'camera' // 摄像头
  | 'tv' // 电视
  | 'air conditioner' // 空调
  | 'other'; // 其他设备

// 设备能力接口
export interface DeviceCapabilities {
  [key: string]: boolean;
}

// 设备属性接口
export interface DeviceProperties {
  [key: string]: unknown;
}

// 设备控制命令接口
export interface DeviceCommand {
  command: string;
  parameters: Record<string, unknown>;
}

// 照明设备接口
export interface LightDevice {
  type: 'light';
  properties: {
    power: boolean;
    brightness: number; // 0-100
    color?: string; // 颜色，如 #FFFFFF
    colorTemperature?: number; // 色温
  };
  capabilities: {
    power: boolean;
    brightness: boolean;
    color: boolean;
    colorTemperature: boolean;
  };
}

// 插座设备接口
export interface OutletDevice {
  type: 'outlet';
  properties: {
    power: boolean;
    powerConsumption?: number; // 功率消耗
  };
  capabilities: {
    power: boolean;
    powerConsumption: boolean;
  };
}

// 传感器设备接口
export interface SensorDevice {
  type: 'sensor';
  properties: {
    temperature?: number; // 温度
    humidity?: number; // 湿度
    motion?: boolean; //  motion检测
    contact?: boolean; // 接触检测
    smoke?: boolean; // 烟雾检测
    CO?: boolean; // 一氧化碳检测
  };
  capabilities: {
    temperature: boolean;
    humidity: boolean;
    motion: boolean;
    contact: boolean;
    smoke: boolean;
    CO: boolean;
  };
}

// 恒温器设备接口
export interface ThermostatDevice {
  type: 'thermostat';
  properties: {
    temperature: number; // 当前温度
    targetTemperature: number; // 目标温度
    mode: 'heat' | 'cool' | 'auto' | 'off'; // 模式
    fanMode: 'on' | 'auto' | 'off'; // 风扇模式
  };
  capabilities: {
    setTemperature: boolean;
    setMode: boolean;
    setFanMode: boolean;
  };
}

// 门锁设备接口
export interface LockDevice {
  type: 'lock';
  properties: {
    locked: boolean;
    batteryLevel?: number; // 电池电量
  };
  capabilities: {
    lock: boolean;
    unlock: boolean;
    getBatteryLevel: boolean;
  };
}

// 窗帘设备接口
export interface BlindDevice {
  type: 'blind';
  properties: {
    position: number; // 0-100，0为关闭，100为打开
    power: boolean;
  };
  capabilities: {
    open: boolean;
    close: boolean;
    setPosition: boolean;
    power: boolean;
  };
}

// 音箱设备接口
export interface SpeakerDevice {
  type: 'speaker';
  properties: {
    power: boolean;
    volume: number; // 0-100
    playing: boolean;
    track?: string;
  };
  capabilities: {
    power: boolean;
    volume: boolean;
    play: boolean;
    pause: boolean;
    stop: boolean;
  };
}

// 摄像头设备接口
export interface CameraDevice {
  type: 'camera';
  properties: {
    power: boolean;
    streaming: boolean;
    motionDetected: boolean;
  };
  capabilities: {
    power: boolean;
    startStreaming: boolean;
    stopStreaming: boolean;
    takeSnapshot: boolean;
  };
}

// 电视设备接口
export interface TvDevice {
  type: 'tv';
  properties: {
    power: boolean;
    volume: number; // 0-100
    channel?: number;
    input?: string;
  };
  capabilities: {
    power: boolean;
    volume: boolean;
    channel: boolean;
    input: boolean;
  };
}

// 空调设备接口
export interface AirConditionerDevice {
  type: 'air conditioner';
  properties: {
    power: boolean;
    temperature: number;
    mode: 'cool' | 'heat' | 'fan' | 'dry' | 'auto';
    fanSpeed: 'low' | 'medium' | 'high' | 'auto';
  };
  capabilities: {
    power: boolean;
    setTemperature: boolean;
    setMode: boolean;
    setFanSpeed: boolean;
  };
}

// 设备类型映射
export const deviceTypeMap: Record<DeviceType, string> = {
  light: '照明设备',
  outlet: '插座',
  sensor: '传感器',
  thermostat: '恒温器',
  lock: '门锁',
  blind: '窗帘',
  speaker: '音箱',
  camera: '摄像头',
  tv: '电视',
  'air conditioner': '空调',
  other: '其他设备',
};

// 设备控制命令映射
export const deviceCommandsMap: Record<DeviceType, string[]> = {
  light: ['power', 'brightness', 'color', 'colorTemperature'],
  outlet: ['power'],
  sensor: [], // 传感器通常只提供数据，不接受控制命令
  thermostat: ['setTemperature', 'setMode', 'setFanMode'],
  lock: ['lock', 'unlock'],
  blind: ['open', 'close', 'setPosition', 'power'],
  speaker: ['power', 'volume', 'play', 'pause', 'stop'],
  camera: ['power', 'startStreaming', 'stopStreaming', 'takeSnapshot'],
  tv: ['power', 'volume', 'channel', 'input'],
  'air conditioner': ['power', 'setTemperature', 'setMode', 'setFanSpeed'],
  other: [],
};

// 获取设备类型的显示名称
export function getDeviceTypeDisplayName(type: DeviceType): string {
  return deviceTypeMap[type] || '未知设备';
}

// 获取设备支持的命令
export function getDeviceSupportedCommands(type: DeviceType): string[] {
  return deviceCommandsMap[type] || [];
}

// 验证设备命令是否有效
export function isValidDeviceCommand(
  type: DeviceType,
  command: string
): boolean {
  const commands = getDeviceSupportedCommands(type);
  return commands.includes(command);
}
