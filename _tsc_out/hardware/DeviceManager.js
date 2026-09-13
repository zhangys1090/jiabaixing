"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeviceManager = void 0;
const Logger_1 = require("../utils/Logger");
const AudioVideoDeviceAccess_1 = require("./AudioVideoDeviceAccess");
const DeviceDiscovery_1 = require("./DeviceDiscovery");
const DeviceTypes_1 = require("./DeviceTypes");
const LocalDeviceAccess_1 = require("./LocalDeviceAccess");
const DeviceAdapter_1 = require("./DeviceAdapter");
class DeviceManager {
    initialized = false;
    devices = new Map();
    deviceStatuses = new Map();
    deviceCommands = new Map();
    deviceHealthAssessments = new Map();
    monitoringInterval;
    reconnectionTimers = new Map();
    localDeviceAccess = null;
    audioVideoDeviceAccess = null;
    deviceDiscovery = DeviceDiscovery_1.DeviceDiscovery.getInstance();
    reconnectionConfig = {
        maxRetries: 5,
        retryInterval: 1000,
        timeout: 3000,
        backoffFactor: 2,
    };
    // 设备状态来源（W3）：默认模拟，可替换为真实 HTTP/MQTT 适配器
    deviceAdapter = new DeviceAdapter_1.SimulatedDeviceAdapter();
    // W3：遥测桥（TS 仅入口/透传，状态推送至 Python 环境感通道）。未设置则不推送。
    telemetryBridge = null;
    constructor() { }
    async initialize() {
        try {
            await this.initializeProtocolHandlers();
            this.localDeviceAccess = new LocalDeviceAccess_1.LocalDeviceAccess();
            await this.localDeviceAccess.initialize();
            this.audioVideoDeviceAccess = new AudioVideoDeviceAccess_1.AudioVideoDeviceAccess();
            await this.audioVideoDeviceAccess.initialize();
            this.deviceDiscovery.setLocalDeviceAccess(this.localDeviceAccess);
            this.deviceDiscovery.setAudioVideoDeviceAccess(this.audioVideoDeviceAccess);
            this.initialized = true;
            this.deviceDiscovery.startDeviceDiscovery(async (options) => {
                return this.discoverDevices(options);
            });
        }
        catch (error) {
            Logger_1.Logger.error('❌ 设备管理器初始化失败', error, 'DeviceManager');
            this.initialized = false;
            throw error;
        }
    }
    async initializeProtocolHandlers() {
        try {
        }
        catch (error) {
            Logger_1.Logger.error('❌ 协议处理器初始化失败', error, 'DeviceManager');
            throw error;
        }
    }
    async discoverDevices(options) {
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
                }
                else {
                    this.devices.set(device.id, device);
                }
            }
            return discoveredDevices;
        }
        catch (error) {
            Logger_1.Logger.error('❌ 设备发现失败', error, 'DeviceManager');
            return [];
        }
    }
    getDevice(id) {
        this.ensureInitialized();
        return this.devices.get(id) || null;
    }
    getDevices() {
        this.ensureInitialized();
        return Array.from(this.devices.values());
    }
    getDevicesByType(type) {
        this.ensureInitialized();
        return Array.from(this.devices.values()).filter((device) => device.type === type);
    }
    getDevicesByStatus(status) {
        this.ensureInitialized();
        return Array.from(this.devices.values()).filter((device) => device.status === status);
    }
    updateDeviceStatus(deviceId, status) {
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
    getDeviceStatus(deviceId) {
        this.ensureInitialized();
        return this.deviceStatuses.get(deviceId) || null;
    }
    sendCommand(deviceId, command, parameters) {
        this.ensureInitialized();
        const device = this.devices.get(deviceId);
        if (!device) {
            throw new Error(`设备 ${deviceId} 不存在`);
        }
        if (!(0, DeviceTypes_1.isValidDeviceCommand)(device.type, command)) {
            throw new Error(`设备 ${device.name} 不支持命令 ${command}`);
        }
        const newCommand = {
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
    getDeviceTypeDisplayName(deviceId) {
        this.ensureInitialized();
        const device = this.devices.get(deviceId);
        if (!device) {
            return '未知设备';
        }
        return (0, DeviceTypes_1.getDeviceTypeDisplayName)(device.type);
    }
    getDeviceSupportedCommands(deviceId) {
        this.ensureInitialized();
        const device = this.devices.get(deviceId);
        if (!device) {
            return [];
        }
        return (0, DeviceTypes_1.getDeviceSupportedCommands)(device.type);
    }
    async executeCommand(commandId) {
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
            Logger_1.Logger.info(`📡 设备管理器：执行命令 ${command.command} 到设备 ${device.name} (${device.type})`, 'DeviceManager');
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
        }
        catch (error) {
            this.deviceCommands.set(commandId, {
                ...command,
                status: 'failed',
                error: error.message,
                updatedAt: new Date(),
            });
            Logger_1.Logger.error(`❌ 设备管理器：命令 ${command.command} 执行失败`, error, 'DeviceManager');
        }
    }
    async executeLightCommand(device, command) {
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
    async executeOutletCommand(device, command) {
        const properties = { ...device.properties };
        if (command.command === 'power') {
            properties.power = command.parameters.power;
        }
        return { properties };
    }
    async executeThermostatCommand(device, command) {
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
    async executeLockCommand(device, command) {
        const properties = { ...device.properties };
        if (command.command === 'lock') {
            properties.locked = true;
        }
        else if (command.command === 'unlock') {
            properties.locked = false;
        }
        return { properties };
    }
    async executeBlindCommand(device, command) {
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
    async executeSpeakerCommand(device, command) {
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
    async executeCameraCommand(device, command) {
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
    async executeTvCommand(device, command) {
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
    async executeAirConditionerCommand(device, command) {
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
    updateDeviceProperties(deviceId, properties) {
        const device = this.devices.get(deviceId);
        if (device) {
            this.devices.set(deviceId, {
                ...device,
                properties: { ...device.properties, ...properties },
                updatedAt: new Date(),
            });
        }
    }
    getCommand(commandId) {
        this.ensureInitialized();
        return this.deviceCommands.get(commandId) || null;
    }
    getDeviceCommands(deviceId) {
        this.ensureInitialized();
        return Array.from(this.deviceCommands.values()).filter((command) => command.deviceId === deviceId);
    }
    startDeviceMonitoring() {
        this.ensureInitialized();
        this.monitoringInterval = setInterval(() => {
            for (const device of this.devices.values()) {
                // W3: 设备状态由注入的适配器提供（模拟或真实），不再硬编码随机
                const status = this.deviceAdapter.sampleStatus(device);
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
        Logger_1.Logger.info('🔄 设备管理器：开始监控设备状态', 'DeviceManager');
    }
    /**
     * 注入设备状态适配器（W3）。可传入 HttpDeviceAdapter / MqttDeviceAdapter
     * 接入真实设备，未注入时默认使用 SimulatedDeviceAdapter。
     */
    setDeviceAdapter(adapter) {
        this.deviceAdapter = adapter;
    }
    getDeviceAdapterKind() {
        return this.deviceAdapter.kind;
    }
    /**
     * 设置遥测桥（W3）：把设备状态推送至 Python 端 ``DeviceSenseChannel``，
     * 经 ``POST /v1/devices/telemetry`` 灌入环境感通道（SensoryFusion）。
     * 仅作入口/透传，不在此做融合逻辑（AGENTS.md §0.1）。
     */
    setTelemetryBridge(bridge) {
        this.telemetryBridge = bridge;
    }
    /**
     * 构造设备遥测载荷，供 Python ``POST /v1/devices/telemetry`` 消费。
     * 字段对齐 python/agent/perception/device_sense.py::DeviceStatus.from_dict。
     */
    buildDeviceTelemetry() {
        const payloads = [];
        for (const device of this.devices.values()) {
            const status = this.deviceStatuses.get(device.id);
            if (!status) {
                continue;
            }
            const state = status.status;
            const payload = {
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
    async publishDeviceTelemetry() {
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
    resolveDeviceLocation(device) {
        const loc = device.location ??
            device.properties?.['location'];
        return typeof loc === 'string' ? loc : undefined;
    }
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('设备管理器未初始化！请先调用initialize方法。');
        }
    }
    assessDeviceHealth(deviceId, status) {
        const device = this.devices.get(deviceId);
        if (!device) {
            throw new Error(`设备 ${deviceId} 不存在`);
        }
        let healthScore = 100;
        const issues = [];
        const recommendations = [];
        const predictions = [];
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
        let healthStatus;
        if (healthScore >= 90) {
            healthStatus = 'excellent';
        }
        else if (healthScore >= 70) {
            healthStatus = 'good';
        }
        else if (healthScore >= 50) {
            healthStatus = 'fair';
        }
        else {
            healthStatus = 'poor';
        }
        const assessment = {
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
    getDeviceHealthAssessment(deviceId) {
        this.ensureInitialized();
        return this.deviceHealthAssessments.get(deviceId) || null;
    }
    attemptReconnection(deviceId) {
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
                const status = {
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
                    clearInterval(this.reconnectionTimers.get(deviceId));
                    this.reconnectionTimers.delete(deviceId);
                }
            }
            else if (retryCount >= this.reconnectionConfig.maxRetries) {
                if (this.reconnectionTimers.has(deviceId)) {
                    clearInterval(this.reconnectionTimers.get(deviceId));
                    this.reconnectionTimers.delete(deviceId);
                }
            }
        };
        reconnect();
        const timer = setInterval(reconnect, this.reconnectionConfig.retryInterval);
        this.reconnectionTimers.set(deviceId, timer);
    }
    simulateReconnection(_device) {
        return Math.random() < 0.5;
    }
    handleDeviceError(deviceId, error) {
        const device = this.devices.get(deviceId);
        if (!device) {
            return;
        }
        Logger_1.Logger.error(`❌ 设备管理器：设备 ${device.name} 发生错误`, error, 'DeviceManager');
        const currentStatus = this.deviceStatuses.get(deviceId);
        const status = {
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
    async shutdown() {
        Logger_1.Logger.info('🔌 设备管理器：关闭中...', 'DeviceManager');
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
exports.DeviceManager = DeviceManager;
