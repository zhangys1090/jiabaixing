"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeviceDiscovery = void 0;
const Logger_1 = require("../utils/Logger");
class DeviceDiscovery {
    static _instance = null;
    discoveryInterval;
    localDeviceAccess = null;
    audioVideoDeviceAccess = null;
    protocolHandlers;
    constructor() {
        this.protocolHandlers = {
            wifi: null,
            bluetooth: null,
            zigbee: null,
            zwave: null,
        };
    }
    static create() {
        return new DeviceDiscovery();
    }
    static getInstance() {
        if (!DeviceDiscovery._instance) {
            DeviceDiscovery._instance = new DeviceDiscovery();
        }
        return DeviceDiscovery._instance;
    }
    setLocalDeviceAccess(access) {
        this.localDeviceAccess = access;
    }
    setAudioVideoDeviceAccess(access) {
        this.audioVideoDeviceAccess = access;
    }
    startDeviceDiscovery(onDiscover) {
        this.discoveryInterval = setInterval(() => {
            void onDiscover({ timeout: 5000 });
        }, 60000);
    }
    stopDeviceDiscovery() {
        if (this.discoveryInterval) {
            clearInterval(this.discoveryInterval);
            this.discoveryInterval = undefined;
        }
    }
    async discoverDevices(options) {
        const protocols = options?.protocols || [
            'wifi',
            'bluetooth',
            'zigbee',
            'zwave',
        ];
        Logger_1.Logger.info('🔍 设备管理器：开始发现设备...', 'DeviceDiscovery');
        try {
            let discoveredDevices = [];
            for (const protocol of protocols) {
                switch (protocol) {
                    case 'wifi':
                        discoveredDevices = [
                            ...discoveredDevices,
                            ...(await this.discoverWifiDevices(options?.wifiOptions)),
                        ];
                        break;
                    case 'bluetooth':
                        discoveredDevices = [
                            ...discoveredDevices,
                            ...(await this.discoverBluetoothDevices(options?.bluetoothOptions)),
                        ];
                        break;
                    case 'zigbee':
                        discoveredDevices = [
                            ...discoveredDevices,
                            ...(await this.discoverZigbeeDevices(options?.zigbeeOptions)),
                        ];
                        break;
                    case 'zwave':
                        discoveredDevices = [
                            ...discoveredDevices,
                            ...(await this.discoverZwaveDevices(options?.zwaveOptions)),
                        ];
                        break;
                }
            }
            if (this.localDeviceAccess) {
                const localDevices = await this.localDeviceAccess.discoverLocalDevices();
                for (const localDevice of localDevices) {
                    discoveredDevices.push({
                        id: localDevice.id,
                        name: localDevice.name,
                        type: 'other',
                        model: localDevice.type,
                        manufacturer: 'Local',
                        status: localDevice.status,
                        protocol: 'other',
                        ipAddress: localDevice.ipAddress,
                        macAddress: localDevice.macAddress,
                        lastSeen: localDevice.lastSeen,
                        properties: localDevice.properties,
                        capabilities: localDevice.capabilities,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    });
                }
            }
            if (this.audioVideoDeviceAccess) {
                const audioVideoDevices = await this.audioVideoDeviceAccess.discoverAudioVideoDevices();
                for (const avDevice of audioVideoDevices) {
                    discoveredDevices.push({
                        id: avDevice.id,
                        name: avDevice.name,
                        type: avDevice.type === 'microphone' || avDevice.type === 'speaker'
                            ? 'speaker'
                            : 'camera',
                        model: avDevice.type,
                        manufacturer: 'AudioVideo',
                        status: avDevice.status,
                        protocol: 'other',
                        lastSeen: avDevice.lastSeen,
                        properties: avDevice.properties,
                        capabilities: avDevice.capabilities,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                    });
                }
            }
            return discoveredDevices;
        }
        catch (error) {
            Logger_1.Logger.error('❌ 设备发现失败', error, 'DeviceDiscovery');
            return [];
        }
    }
    async discoverWifiDevices(_options) {
        return [
            {
                id: `wifi_${Date.now()}_1`,
                name: '智能灯泡',
                type: 'light',
                model: 'SmartLight-100',
                manufacturer: 'SmartHome Inc.',
                status: 'online',
                protocol: 'wifi',
                ipAddress: '192.168.1.100',
                macAddress: 'AA:BB:CC:DD:EE:FF',
                lastSeen: new Date(),
                properties: {
                    brightness: 80,
                    color: '#FFFFFF',
                    power: true,
                },
                capabilities: ['power', 'brightness', 'color'],
                createdAt: new Date(),
                updatedAt: new Date(),
            },
            {
                id: `wifi_${Date.now()}_2`,
                name: '智能插座',
                type: 'outlet',
                model: 'SmartOutlet-200',
                manufacturer: 'SmartHome Inc.',
                status: 'online',
                protocol: 'wifi',
                ipAddress: '192.168.1.101',
                macAddress: 'AA:BB:CC:DD:EE:GG',
                lastSeen: new Date(),
                properties: {
                    power: true,
                    powerConsumption: 120,
                },
                capabilities: ['power', 'powerConsumption'],
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        ];
    }
    async discoverBluetoothDevices(_options) {
        return [
            {
                id: `bluetooth_${Date.now()}_1`,
                name: '蓝牙音箱',
                type: 'speaker',
                model: 'BluetoothSpeaker-300',
                manufacturer: 'AudioTech',
                status: 'online',
                protocol: 'bluetooth',
                bluetoothAddress: 'AA:BB:CC:DD:EE:HH',
                lastSeen: new Date(),
                properties: {
                    volume: 60,
                    power: true,
                },
                capabilities: ['power', 'volume'],
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        ];
    }
    async discoverZigbeeDevices(_options) {
        return [
            {
                id: `zigbee_${Date.now()}_1`,
                name: 'Zigbee温度传感器',
                type: 'sensor',
                model: 'ZigbeeTempSensor-400',
                manufacturer: 'SensorTech',
                status: 'online',
                protocol: 'zigbee',
                zigbeeId: '0x1234',
                lastSeen: new Date(),
                properties: {
                    temperature: 25.5,
                    humidity: 45,
                },
                capabilities: ['temperature', 'humidity'],
                createdAt: new Date(),
                updatedAt: new Date(),
            },
            {
                id: `zigbee_${Date.now()}_2`,
                name: 'Zigbee门锁',
                type: 'lock',
                model: 'ZigbeeLock-500',
                manufacturer: 'SecureTech',
                status: 'online',
                protocol: 'zigbee',
                zigbeeId: '0x5678',
                lastSeen: new Date(),
                properties: {
                    locked: true,
                },
                capabilities: ['lock', 'unlock'],
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        ];
    }
    async discoverZwaveDevices(_options) {
        return [
            {
                id: `zwave_${Date.now()}_1`,
                name: 'Z-Wave窗帘控制器',
                type: 'blind',
                model: 'ZwaveBlind-600',
                manufacturer: 'HomeTech',
                status: 'online',
                protocol: 'zwave',
                zwaveId: '0x9ABC',
                lastSeen: new Date(),
                properties: {
                    position: 50,
                },
                capabilities: ['open', 'close', 'setPosition'],
                createdAt: new Date(),
                updatedAt: new Date(),
            },
            {
                id: `zwave_${Date.now()}_2`,
                name: 'Z-Wave恒温器',
                type: 'thermostat',
                model: 'ZwaveThermo-700',
                manufacturer: 'ClimateTech',
                status: 'online',
                protocol: 'zwave',
                zwaveId: '0xDEF0',
                lastSeen: new Date(),
                properties: {
                    temperature: 22,
                    mode: 'heat',
                },
                capabilities: ['setTemperature', 'setMode'],
                createdAt: new Date(),
                updatedAt: new Date(),
            },
        ];
    }
}
exports.DeviceDiscovery = DeviceDiscovery;
