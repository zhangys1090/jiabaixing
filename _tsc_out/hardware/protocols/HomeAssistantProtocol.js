"use strict";
/**
 * Home Assistant 协议实现
 * 通过 WebSocket API 连接 Home Assistant 智能家居平台
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HomeAssistantProtocol = void 0;
const ws_1 = __importDefault(require("ws"));
const Logger_1 = require("../../utils/Logger");
/**
 * Home Assistant 协议
 */
class HomeAssistantProtocol {
    name = 'Home Assistant';
    version = '1.0';
    ws = null;
    config = null;
    messageId = 1;
    pendingMessages = new Map();
    subscriptions = new Map();
    authenticated = false;
    /**
     * 初始化协议连接
     */
    async initialize(config) {
        this.config = config;
        const token = config.token || '';
        const host = config.host || 'localhost';
        const port = config.port || 8123;
        try {
            return new Promise((resolve, reject) => {
                const wsUrl = `ws://${host}:${port}/api/websocket`;
                this.ws = new ws_1.default(wsUrl);
                const timeout = setTimeout(() => {
                    reject(new Error('Home Assistant 连接超时'));
                }, config.timeout || 10000);
                this.ws.on('open', () => {
                    Logger_1.Logger.info('Home Assistant WebSocket 连接已建立', 'HomeAssistant');
                });
                this.ws.on('message', (data) => {
                    try {
                        const message = JSON.parse(data.toString());
                        this.handleMessage(message, token, resolve, reject, timeout);
                    }
                    catch (error) {
                        Logger_1.Logger.error('Home Assistant 消息解析失败', error, 'HomeAssistant');
                    }
                });
                this.ws.on('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
                this.ws.on('close', () => {
                    this.authenticated = false;
                    Logger_1.Logger.info('Home Assistant WebSocket 连接已关闭', 'HomeAssistant');
                });
            });
        }
        catch (error) {
            return {
                success: false,
                error: `Home Assistant 初始化失败: ${error.message}`,
            };
        }
    }
    /**
     * 发现设备
     */
    async discover() {
        if (!this.authenticated || !this.ws) {
            return { success: false, error: '未连接到 Home Assistant' };
        }
        try {
            const states = (await this.sendMessage({ type: 'get_states' }));
            const devices = states.map((state) => {
                const domain = state.entity_id.split('.')[0];
                const name = state.attributes.friendly_name || state.entity_id;
                return {
                    id: state.entity_id,
                    name,
                    type: this.mapDomainToType(domain),
                    protocol: 'homeassistant',
                    address: state.entity_id,
                    properties: {
                        state: state.state,
                        ...state.attributes,
                    },
                    capabilities: this.inferCapabilities(domain, state.attributes),
                    online: state.state !== 'unavailable',
                };
            });
            return { success: true, data: devices };
        }
        catch (error) {
            return {
                success: false,
                error: `设备发现失败: ${error.message}`,
            };
        }
    }
    /**
     * 获取设备状态
     */
    async getState(deviceId) {
        if (!this.authenticated || !this.ws) {
            return { success: false, error: '未连接到 Home Assistant' };
        }
        try {
            const state = (await this.sendMessage({
                type: 'get_states',
            }));
            const deviceState = state.find((s) => s.entity_id === deviceId);
            if (!deviceState) {
                return { success: false, error: `设备 ${deviceId} 不存在` };
            }
            return {
                success: true,
                data: this.parseState(deviceState.state, deviceState.attributes),
            };
        }
        catch (error) {
            return {
                success: false,
                error: `获取状态失败: ${error.message}`,
            };
        }
    }
    /**
     * 发送命令到设备
     */
    async sendCommand(deviceId, command, params) {
        if (!this.authenticated || !this.ws) {
            return { success: false, error: '未连接到 Home Assistant' };
        }
        try {
            const domain = deviceId.split('.')[0];
            const service = this.mapCommandToService(command);
            await this.sendMessage({
                type: 'call_service',
                domain,
                service,
                service_data: {
                    entity_id: deviceId,
                    ...params,
                },
            });
            return { success: true };
        }
        catch (error) {
            return {
                success: false,
                error: `命令执行失败: ${error.message}`,
            };
        }
    }
    /**
     * 订阅设备状态变化
     */
    async subscribe(deviceId, callback) {
        if (!this.authenticated || !this.ws) {
            return { success: false, error: '未连接到 Home Assistant' };
        }
        this.subscriptions.set(deviceId, callback);
        try {
            await this.sendMessage({
                type: 'subscribe_events',
                event_type: 'state_changed',
            });
            return { success: true };
        }
        catch (error) {
            this.subscriptions.delete(deviceId);
            return {
                success: false,
                error: `订阅失败: ${error.message}`,
            };
        }
    }
    /**
     * 取消订阅
     */
    async unsubscribe(deviceId) {
        this.subscriptions.delete(deviceId);
        return { success: true };
    }
    /**
     * 关闭协议连接
     */
    async shutdown() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.authenticated = false;
        this.subscriptions.clear();
        this.pendingMessages.clear();
        return { success: true };
    }
    /**
     * 处理 WebSocket 消息
     */
    handleMessage(message, token, resolve, reject, timeout) {
        const msgType = message.type;
        switch (msgType) {
            case 'auth_required':
                // 发送认证
                if (this.ws) {
                    this.ws.send(JSON.stringify({ type: 'auth', access_token: token }));
                }
                break;
            case 'auth_ok':
                this.authenticated = true;
                clearTimeout(timeout);
                resolve({ success: true });
                break;
            case 'auth_invalid':
                clearTimeout(timeout);
                reject(new Error('Home Assistant 认证失败'));
                break;
            case 'result': {
                const id = message.id;
                const pending = this.pendingMessages.get(id);
                if (pending) {
                    this.pendingMessages.delete(id);
                    if (message.success) {
                        pending.resolve(message.result);
                    }
                    else {
                        pending.reject(new Error(message.error?.message || '未知错误'));
                    }
                }
                break;
            }
            case 'event': {
                const event = message.event
                    ?.data;
                if (event) {
                    const entityId = event.entity_id;
                    const newState = event.new_state;
                    if (entityId && newState) {
                        const callback = this.subscriptions.get(entityId);
                        if (callback) {
                            callback(this.parseState(newState.state, newState.attributes));
                        }
                    }
                }
                break;
            }
        }
    }
    /**
     * 发送消息并等待响应
     */
    sendMessage(message) {
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== ws_1.default.OPEN) {
                reject(new Error('WebSocket 未连接'));
                return;
            }
            const id = this.messageId++;
            this.pendingMessages.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ ...message, id }));
            // 超时处理
            setTimeout(() => {
                if (this.pendingMessages.has(id)) {
                    this.pendingMessages.delete(id);
                    reject(new Error('消息响应超时'));
                }
            }, this.config?.timeout || 10000);
        });
    }
    /**
     * 映射 domain 到设备类型
     */
    mapDomainToType(domain) {
        const map = {
            light: 'light',
            switch: 'outlet',
            sensor: 'sensor',
            climate: 'thermostat',
            lock: 'lock',
            cover: 'blind',
            media_player: 'speaker',
            camera: 'camera',
            fan: 'air conditioner',
            binary_sensor: 'sensor',
        };
        return map[domain] || 'other';
    }
    /**
     * 推断设备能力
     */
    inferCapabilities(domain, attributes) {
        const caps = [];
        switch (domain) {
            case 'light':
                caps.push('power');
                if (attributes.brightness !== undefined)
                    caps.push('brightness');
                if (attributes.rgb_color !== undefined)
                    caps.push('color');
                if (attributes.color_temp !== undefined)
                    caps.push('colorTemperature');
                break;
            case 'switch':
                caps.push('power');
                break;
            case 'climate':
                caps.push('setTemperature', 'setMode', 'setFanMode');
                break;
            case 'lock':
                caps.push('lock', 'unlock');
                break;
            case 'cover':
                caps.push('open', 'close', 'setPosition');
                break;
            case 'media_player':
                caps.push('power', 'volume', 'play', 'pause', 'stop');
                break;
            case 'camera':
                caps.push('power', 'takeSnapshot');
                break;
        }
        return caps;
    }
    /**
     * 映射命令到 Home Assistant 服务
     */
    mapCommandToService(command) {
        const map = {
            power: 'toggle',
            turnOn: 'turn_on',
            turnOff: 'turn_off',
            brightness: 'turn_on',
            color: 'turn_on',
            colorTemperature: 'turn_on',
            setTemperature: 'set_temperature',
            setMode: 'set_hvac_mode',
            setFanMode: 'set_fan_mode',
            lock: 'lock',
            unlock: 'unlock',
            open: 'open_cover',
            close: 'close_cover',
            setPosition: 'set_cover_position',
            volume: 'volume_set',
            play: 'media_play',
            pause: 'media_pause',
            stop: 'media_stop',
        };
        return map[command] || command;
    }
    /**
     * 解析状态
     */
    parseState(state, attributes) {
        const result = {
            online: state !== 'unavailable' && state !== 'unknown',
        };
        if (state === 'on' || state === 'off') {
            result.power = state === 'on';
        }
        if (attributes.brightness !== undefined) {
            result.brightness = Math.round((attributes.brightness / 255) * 100);
        }
        if (attributes.temperature !== undefined) {
            result.temperature = attributes.temperature;
        }
        return result;
    }
}
exports.HomeAssistantProtocol = HomeAssistantProtocol;
