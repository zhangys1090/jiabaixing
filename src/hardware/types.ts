import { DeviceType } from './DeviceTypes';

export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  model: string;
  manufacturer: string;
  status: 'online' | 'offline' | 'error' | 'warning';
  protocol: 'wifi' | 'bluetooth' | 'zigbee' | 'zwave' | 'other';
  ipAddress?: string;
  macAddress?: string;
  zigbeeId?: string;
  zwaveId?: string;
  bluetoothAddress?: string;
  lastSeen: Date;
  properties: Record<string, unknown>;
  capabilities: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface DeviceStatus {
  deviceId: string;
  timestamp: Date;
  status: 'online' | 'offline' | 'error' | 'warning';
  batteryLevel?: number;
  signalStrength?: number;
  temperature?: number;
  humidity?: number;
  pressure?: number;
  cpuUsage?: number;
  memoryUsage?: number;
  diskUsage?: number;
  networkSpeed?: number;
  uptime?: number;
  otherMetrics: Record<string, unknown>;
}

export interface DeviceHealthAssessment {
  deviceId: string;
  timestamp: Date;
  healthScore: number;
  status: 'excellent' | 'good' | 'fair' | 'poor';
  issues: DeviceHealthIssue[];
  recommendations: string[];
  predictions: DeviceHealthPrediction[];
}

export interface DeviceHealthIssue {
  id: string;
  type: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  timestamp: Date;
  possibleCauses: string[];
  suggestedActions: string[];
}

export interface DeviceHealthPrediction {
  id: string;
  type: string;
  probability: number;
  timestamp: Date;
  description: string;
  suggestedActions: string[];
  expectedTime?: Date;
}

export interface DeviceReconnectionConfig {
  maxRetries: number;
  retryInterval: number;
  timeout: number;
  backoffFactor: number;
}

export interface DeviceCommand {
  id: string;
  deviceId: string;
  command: string;
  parameters: Record<string, unknown>;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  createdAt: Date;
  updatedAt: Date;
  result?: unknown;
  error?: string;
}

export interface DeviceDiscoveryOptions {
  timeout?: number;
  protocols?: ('wifi' | 'bluetooth' | 'zigbee' | 'zwave' | 'other')[];
  filters?: Record<string, string>;
  wifiOptions?: {
    subnet?: string;
    port?: number;
  };
  bluetoothOptions?: {
    serviceUuids?: string[];
  };
  zigbeeOptions?: {
    networkKey?: string;
    channel?: number;
  };
  zwaveOptions?: {
    homeId?: number;
  };
}
