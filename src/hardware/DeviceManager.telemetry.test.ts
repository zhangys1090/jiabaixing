import { DeviceManager } from './DeviceManager';
import type { Device, DeviceStatus } from './types';

function makeDevice(): Device {
  return {
    id: 'dev-1',
    name: '客厅灯',
    type: 'light',
    model: 'L1',
    manufacturer: 'X',
    status: 'online',
    protocol: 'wifi',
    lastSeen: new Date(),
    properties: { location: '客厅' },
    capabilities: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeStatus(): DeviceStatus {
  return {
    deviceId: 'dev-1',
    timestamp: new Date(),
    status: 'online',
    batteryLevel: 80,
    signalStrength: 90,
    temperature: 25,
    otherMetrics: {},
  };
}

function makeManager(): DeviceManager {
  const dm = new DeviceManager();
  (dm as unknown as { devices: Map<string, Device> }).devices.set('dev-1', makeDevice());
  (dm as unknown as { deviceStatuses: Map<string, DeviceStatus> }).deviceStatuses.set(
    'dev-1',
    makeStatus()
  );
  return dm;
}

describe('DeviceManager W3 遥测（TS 入口/透传）', () => {
  it('buildDeviceTelemetry 对齐 Python 设备状态 schema', () => {
    const payloads = makeManager().buildDeviceTelemetry();
    expect(payloads).toHaveLength(1);
    const p = payloads[0];
    expect(p.device_id).toBe('dev-1');
    expect(p.kind).toBe('light');
    expect(p.state).toBe('online');
    expect(p.online).toBe(true);
    expect(p.location).toBe('客厅');
    expect(p.batteryLevel).toBe(80);
    expect(p.temperature).toBe(25);
  });

  it('离线状态 online=false', () => {
    const dm = makeManager();
    (dm as unknown as { deviceStatuses: Map<string, DeviceStatus> }).deviceStatuses.set(
      'dev-1',
      { ...makeStatus(), status: 'offline' }
    );
    const p = dm.buildDeviceTelemetry()[0];
    expect(p.online).toBe(false);
    expect(p.state).toBe('offline');
  });

  it('publishDeviceTelemetry 推送到桥并返回 ingested 数', async () => {
    const dm = makeManager();
    const bridge = {
      postDeviceTelemetry: jest
        .fn()
        .mockResolvedValue({ ok: true, ingested: 1 }),
    };
    dm.setTelemetryBridge(bridge as never);
    const n = await dm.publishDeviceTelemetry();
    expect(n).toBe(1);
    expect(bridge.postDeviceTelemetry).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ device_id: 'dev-1' })])
    );
  });

  it('未设置桥时 publishDeviceTelemetry 返回 -1', async () => {
    const n = await makeManager().publishDeviceTelemetry();
    expect(n).toBe(-1);
  });
});
