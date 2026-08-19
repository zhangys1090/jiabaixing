import { Device, DeviceStatus } from './types';

/**
 * 设备适配器抽象（W3）—— 把"设备状态从何而来"与 DeviceManager 解耦。
 *
 * 之前 DeviceManager 直接调用内部的 ``simulateDeviceStatus`` 生成随机状态，
 * 属于纯模拟，无法接入真实设备。引入 DeviceAdapter 后：
 * - SimulatedDeviceAdapter：保留既有模拟能力，作为默认/fallback；
 * - HttpDeviceAdapter：从真实设备/网关 HTTP 接口拉取状态，失败则降级到模拟。
 *
 * 该抽象符合"TS 侧仅做入口/透传、业务逻辑可下沉"的架构原则；
 * 后续可将真实采集逻辑下沉到 Python 端设备服务，TS 仅做 HTTP 入口。
 */
export interface DeviceAdapter {
  /** 适配器类型，便于诊断与路由。 */
  readonly kind: 'simulated' | 'http' | 'mqtt';
  /**
   * 采样设备当前状态（同步快照，便于接入 setInterval 监控循环）。
   * 真实适配器应返回最近一次成功拉取的状态；拉取失败则降级到模拟值。
   */
  sampleStatus(device: Device): DeviceStatus;
  /** 触发一次真实状态拉取（异步），用于后台定时刷新缓存。 */
  refresh(device: Device): Promise<void>;
}

function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

export class SimulatedDeviceAdapter implements DeviceAdapter {
  public readonly kind = 'simulated' as const;
  /** 可注入随机源，便于单元测试确定性。 */
  private readonly rng: () => number;

  constructor(rng: () => number = Math.random) {
    this.rng = rng;
  }

  public sampleStatus(device: Device): DeviceStatus {
    return {
      deviceId: device.id,
      timestamp: new Date(),
      status: this.simulateStatus(device),
      batteryLevel: randomInt(100),
      signalStrength: randomInt(100),
      temperature: 20 + this.rng() * 10,
      humidity: 40 + this.rng() * 20,
      cpuUsage: randomInt(100),
      memoryUsage: randomInt(100),
      diskUsage: randomInt(100),
      networkSpeed: randomInt(1000),
      uptime: randomInt(86400),
      otherMetrics: {
        uptime: randomInt(86400),
        responseTime: this.rng() * 1000,
      },
    };
  }

  public async refresh(_device: Device): Promise<void> {
    // 模拟适配器无需网络刷新
    return;
  }

  private simulateStatus(device: Device): Device['status'] {
    const random = this.rng();
    if (random < 0.1) return 'offline';
    if (random < 0.2) return 'warning';
    if (random < 0.25) return 'error';
    return 'online';
  }
}

export interface HttpAdapterOptions {
  /** 设备状态接口基地址，例如 http://gateway.local/api/devices */
  baseUrl: string;
  /** 拉取超时（毫秒） */
  timeoutMs?: number;
  /** 真实拉取失败时的降级适配器，默认 new SimulatedDeviceAdapter() */
  fallback?: SimulatedDeviceAdapter;
}

/**
 * 真实设备 HTTP 适配器：从设备/网关的状态接口拉取数据。
 *
 * 由于监控循环是同步 setInterval，``sampleStatus`` 直接返回最近一次缓存，
 * 真正的网络拉取由 ``refresh``（后台定时触发）完成；拉取失败时降级到 fallback。
 */
export class HttpDeviceAdapter implements DeviceAdapter {
  public readonly kind = 'http' as const;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fallback: SimulatedDeviceAdapter;
  private cache: Map<string, DeviceStatus> = new Map();

  constructor(options: HttpAdapterOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.fallback = options.fallback ?? new SimulatedDeviceAdapter();
  }

  public sampleStatus(device: Device): DeviceStatus {
    const cached = this.cache.get(device.id);
    if (cached) return cached;
    // 尚未拉取过 -> 先用模拟值占位，避免返回空状态
    return this.fallback.sampleStatus(device);
  }

  public async refresh(device: Device): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/${encodeURIComponent(device.id)}/status`, {
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Partial<DeviceStatus>;
      this.cache.set(device.id, {
        deviceId: device.id,
        timestamp: new Date(),
        status: (data.status as DeviceStatus['status']) ?? 'online',
        batteryLevel: data.batteryLevel,
        signalStrength: data.signalStrength,
        temperature: data.temperature,
        humidity: data.humidity,
        cpuUsage: data.cpuUsage,
        memoryUsage: data.memoryUsage,
        diskUsage: data.diskUsage,
        networkSpeed: data.networkSpeed,
        uptime: data.uptime,
        otherMetrics: data.otherMetrics ?? {},
      });
    } catch {
      // 拉取失败：降级到模拟并缓存，保证监控循环不中断
      this.cache.set(device.id, this.fallback.sampleStatus(device));
    } finally {
      clearTimeout(timer);
    }
  }
}
