"use strict";
/**
 * 设备类型库
 * 定义不同类型设备的标准接口和控制方法
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.deviceCommandsMap = exports.deviceTypeMap = void 0;
exports.getDeviceTypeDisplayName = getDeviceTypeDisplayName;
exports.getDeviceSupportedCommands = getDeviceSupportedCommands;
exports.isValidDeviceCommand = isValidDeviceCommand;
// 设备类型映射
exports.deviceTypeMap = {
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
exports.deviceCommandsMap = {
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
function getDeviceTypeDisplayName(type) {
    return exports.deviceTypeMap[type] || '未知设备';
}
// 获取设备支持的命令
function getDeviceSupportedCommands(type) {
    return exports.deviceCommandsMap[type] || [];
}
// 验证设备命令是否有效
function isValidDeviceCommand(type, command) {
    const commands = getDeviceSupportedCommands(type);
    return commands.includes(command);
}
