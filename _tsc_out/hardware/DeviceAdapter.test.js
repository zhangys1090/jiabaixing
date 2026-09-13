"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const DeviceAdapter_1 = require("./DeviceAdapter");
function makeDevice(over = {}) {
    return {
        id: 'dev-1',
        name: 'Test Device',
        type: 'light',
        model: 'TestModel',
        manufacturer: 'TestMfg',
        status: 'online',
        protocol: 'wifi',
        ipAddress: '127.0.0.1',
        lastSeen: new Date(),
        properties: {},
        capabilities: [],
        createdAt: new Date(),
        updatedAt: new Date(),
        ...over,
    };
}
describe('SimulatedDeviceAdapter (W3)', () => {
    it('produces deterministic status from injected rng', () => {
        const rng = () => 0.5; // 命中 online 分支
        const adapter = new DeviceAdapter_1.SimulatedDeviceAdapter(rng);
        const status = adapter.sampleStatus(makeDevice());
        expect(status.deviceId).toBe('dev-1');
        expect(status.status).toBe('online');
        expect(status.batteryLevel).toBeGreaterThanOrEqual(0);
        expect(status.batteryLevel).toBeLessThan(100);
    });
    it('maps low rng to offline', () => {
        const adapter = new DeviceAdapter_1.SimulatedDeviceAdapter(() => 0.01);
        expect(adapter.sampleStatus(makeDevice()).status).toBe('offline');
    });
    it('kind is simulated', () => {
        expect(new DeviceAdapter_1.SimulatedDeviceAdapter().kind).toBe('simulated');
    });
});
describe('HttpDeviceAdapter (W3)', () => {
    it('falls back to simulated status before any refresh', () => {
        const adapter = new DeviceAdapter_1.HttpDeviceAdapter({
            baseUrl: 'http://127.0.0.1:9/status',
        });
        const status = adapter.sampleStatus(makeDevice());
        expect(status.deviceId).toBe('dev-1');
        expect(adapter.kind).toBe('http');
    });
    it('refresh failure degrades to fallback without throwing', async () => {
        const adapter = new DeviceAdapter_1.HttpDeviceAdapter({
            baseUrl: 'http://127.0.0.1:9/none',
        });
        await expect(adapter.refresh(makeDevice())).resolves.toBeUndefined();
        // 刷新失败后仍能返回状态（降级模拟）
        expect(adapter.sampleStatus(makeDevice()).deviceId).toBe('dev-1');
    });
});
