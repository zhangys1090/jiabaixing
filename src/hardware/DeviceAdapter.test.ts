import { SimulatedDeviceAdapter, HttpDeviceAdapter } from './DeviceAdapter';
import { Device, DeviceStatus } from './types';

function makeDevice(over: Partial<Device> = {}): Device {
  return {
    id: 'dev-1',
    name: 'Test Device',
    type: 'light',
    status: 'online',
    ip: '127.0.0.1',
    port: 80,
    protocol: 'http',
    capabilities: [],
    metadata: {},
    ...over,
  };
}

describe('SimulatedDeviceAdapter (W3)', () => {
  it('produces deterministic status from injected rng', () => {
    const rng = () => 0.5; // 命中 online 分支
    const adapter = new SimulatedDeviceAdapter(rng);
    const status: DeviceStatus = adapter.sampleStatus(makeDevice());
    expect(status.deviceId).toBe('dev-1');
    expect(status.status).toBe('online');
    expect(status.batteryLevel).toBeGreaterThanOrEqual(0);
    expect(status.batteryLevel).toBeLessThan(100);
  });

  it('maps low rng to offline', () => {
    const adapter = new SimulatedDeviceAdapter(() => 0.01);
    expect(adapter.sampleStatus(makeDevice()).status).toBe('offline');
  });

  it('kind is simulated', () => {
    expect(new SimulatedDeviceAdapter().kind).toBe('simulated');
  });
});

describe('HttpDeviceAdapter (W3)', () => {
  it('falls back to simulated status before any refresh', () => {
    const adapter = new HttpDeviceAdapter({ baseUrl: 'http://127.0.0.1:9/status' });
    const status = adapter.sampleStatus(makeDevice());
    expect(status.deviceId).toBe('dev-1');
    expect(adapter.kind).toBe('http');
  });

  it('refresh failure degrades to fallback without throwing', async () => {
    const adapter = new HttpDeviceAdapter({ baseUrl: 'http://127.0.0.1:9/none' });
    await expect(adapter.refresh(makeDevice())).resolves.toBeUndefined();
    // 刷新失败后仍能返回状态（降级模拟）
    expect(adapter.sampleStatus(makeDevice()).deviceId).toBe('dev-1');
  });
});
