"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpDeviceAdapter = exports.SimulatedDeviceAdapter = void 0;
function randomInt(max) {
    return Math.floor(Math.random() * max);
}
class SimulatedDeviceAdapter {
    kind = 'simulated';
    /** 可注入随机源，便于单元测试确定性。 */
    rng;
    constructor(rng = Math.random) {
        this.rng = rng;
    }
    sampleStatus(device) {
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
    async refresh(_device) {
        // 模拟适配器无需网络刷新
        return;
    }
    simulateStatus(_device) {
        const random = this.rng();
        if (random < 0.1)
            return 'offline';
        if (random < 0.2)
            return 'warning';
        if (random < 0.25)
            return 'error';
        return 'online';
    }
}
exports.SimulatedDeviceAdapter = SimulatedDeviceAdapter;
/**
 * 真实设备 HTTP 适配器：从设备/网关的状态接口拉取数据。
 *
 * 由于监控循环是同步 setInterval，``sampleStatus`` 直接返回最近一次缓存，
 * 真正的网络拉取由 ``refresh``（后台定时触发）完成；拉取失败时降级到 fallback。
 */
class HttpDeviceAdapter {
    kind = 'http';
    baseUrl;
    timeoutMs;
    fallback;
    cache = new Map();
    constructor(options) {
        this.baseUrl = options.baseUrl.replace(/\/$/, '');
        this.timeoutMs = options.timeoutMs ?? 3000;
        this.fallback = options.fallback ?? new SimulatedDeviceAdapter();
    }
    sampleStatus(device) {
        const cached = this.cache.get(device.id);
        if (cached)
            return cached;
        // 尚未拉取过 -> 先用模拟值占位，避免返回空状态
        return this.fallback.sampleStatus(device);
    }
    async refresh(device) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await fetch(`${this.baseUrl}/${encodeURIComponent(device.id)}/status`, {
                signal: controller.signal,
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const data = (await res.json());
            this.cache.set(device.id, {
                deviceId: device.id,
                timestamp: new Date(),
                status: data.status ?? 'online',
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
        }
        catch {
            // 拉取失败：降级到模拟并缓存，保证监控循环不中断
            this.cache.set(device.id, this.fallback.sampleStatus(device));
        }
        finally {
            clearTimeout(timer);
        }
    }
}
exports.HttpDeviceAdapter = HttpDeviceAdapter;
