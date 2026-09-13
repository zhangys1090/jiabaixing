"use strict";
/**
 * 智能家居管理器
 * 统一的设备管理入口，支持多协议驱动
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SmartHomeManager = void 0;
const Logger_1 = require("../utils/Logger");
const HomeAssistantProtocol_1 = require("./protocols/HomeAssistantProtocol");
/**
 * 智能家居管理器
 */
class SmartHomeManager {
    protocols = new Map();
    devices = new Map();
    deviceStates = new Map();
    initialized = false;
    /**
     * 初始化智能家居管理器
     */
    async initialize() {
        // 注册内置协议
        this.registerProtocol('homeassistant', new HomeAssistantProtocol_1.HomeAssistantProtocol());
        this.initialized = true;
        Logger_1.Logger.info('智能家居管理器初始化完成', 'SmartHomeManager');
    }
    /**
     * 注册协议驱动
     */
    registerProtocol(name, protocol) {
        this.protocols.set(name, protocol);
        Logger_1.Logger.info(`注册协议驱动: ${name} v${protocol.version}`, 'SmartHomeManager');
    }
    /**
     * 连接协议
     */
    async connectProtocol(name, config) {
        const protocol = this.protocols.get(name);
        if (!protocol) {
            return { success: false, error: `协议 ${name} 未注册` };
        }
        const result = await protocol.initialize(config);
        if (result.success) {
            Logger_1.Logger.info(`协议 ${name} 连接成功`, 'SmartHomeManager');
        }
        return result;
    }
    /**
     * 发现所有设备
     */
    async discoverAll() {
        const allDevices = [];
        for (const [name, protocol] of this.protocols.entries()) {
            try {
                const result = await protocol.discover();
                if (result.success && result.data) {
                    const devices = result.data;
                    for (const device of devices) {
                        this.devices.set(device.id, device);
                        allDevices.push(device);
                    }
                    Logger_1.Logger.info(`协议 ${name} 发现 ${devices.length} 个设备`, 'SmartHomeManager');
                }
            }
            catch (error) {
                Logger_1.Logger.warn(`协议 ${name} 设备发现失败: ${error.message}`, 'SmartHomeManager');
            }
        }
        return allDevices;
    }
    /**
     * 获取设备
     */
    getDevice(deviceId) {
        return this.devices.get(deviceId);
    }
    /**
     * 获取所有设备
     */
    getAllDevices() {
        return Array.from(this.devices.values());
    }
    /**
     * 按类型获取设备
     */
    getDevicesByType(type) {
        return Array.from(this.devices.values()).filter((d) => d.type === type);
    }
    /**
     * 按协议获取设备
     */
    getDevicesByProtocol(protocol) {
        return Array.from(this.devices.values()).filter((d) => d.protocol === protocol);
    }
    /**
     * 获取设备状态
     */
    async getDeviceState(deviceId) {
        const device = this.devices.get(deviceId);
        if (!device)
            return undefined;
        const protocol = this.protocols.get(device.protocol);
        if (!protocol)
            return undefined;
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
    async sendCommand(deviceId, command, params) {
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
    async subscribe(deviceId, callback) {
        const device = this.devices.get(deviceId);
        if (!device)
            return false;
        const protocol = this.protocols.get(device.protocol);
        if (!protocol)
            return false;
        const result = await protocol.subscribe(deviceId, (state) => {
            this.deviceStates.set(deviceId, state);
            callback(state);
        });
        return result.success;
    }
    /**
     * 批量控制设备
     */
    async batchControl(operations) {
        const results = [];
        for (const op of operations) {
            const result = await this.sendCommand(op.deviceId, op.command, op.params);
            results.push(result);
        }
        return results;
    }
    /**
     * 场景执行
     */
    async executeScene(sceneName, actions) {
        Logger_1.Logger.info(`执行场景: ${sceneName}`, 'SmartHomeManager');
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
    async disconnectProtocol(name) {
        const protocol = this.protocols.get(name);
        if (protocol) {
            await protocol.shutdown();
            Logger_1.Logger.info(`协议 ${name} 已断开`, 'SmartHomeManager');
        }
    }
    /**
     * 关闭管理器
     */
    async shutdown() {
        for (const [name, protocol] of this.protocols.entries()) {
            try {
                await protocol.shutdown();
                Logger_1.Logger.info(`协议 ${name} 已关闭`, 'SmartHomeManager');
            }
            catch (error) {
                Logger_1.Logger.warn(`协议 ${name} 关闭失败: ${error.message}`, 'SmartHomeManager');
            }
        }
        this.protocols.clear();
        this.devices.clear();
        this.deviceStates.clear();
        this.initialized = false;
        Logger_1.Logger.info('智能家居管理器已关闭', 'SmartHomeManager');
    }
    /**
     * 获取统计信息
     */
    getStats() {
        const allDevices = Array.from(this.devices.values());
        return {
            protocolCount: this.protocols.size,
            deviceCount: allDevices.length,
            onlineDeviceCount: allDevices.filter((d) => d.online).length,
        };
    }
}
exports.SmartHomeManager = SmartHomeManager;
