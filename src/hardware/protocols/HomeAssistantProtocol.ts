/**
 * Home Assistant 协议实现
 * 通过 WebSocket API 连接 Home Assistant 智能家居平台
 */

import WebSocket from 'ws';
import {
  DeviceProtocol,
  ProtocolConfig,
  DiscoveredDevice,
  DeviceState,
  ProtocolResult,
} from './DeviceProtocol';
import { Logger } from '../../utils/Logger';

/**
 * Home Assistant 协议
 */
export class HomeAssistantProtocol implements DeviceProtocol {
  readonly name = 'Home Assistant';
  readonly version = '1.0';

  private ws: WebSocket | null = null;
  private config: ProtocolConfig | null = null;
  private messageId = 1;
  private pendingMessages: Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  > = new Map();
  private subscriptions: Map<string, (state: DeviceState) => void> = new Map();
  private authenticated: boolean = false;

  /**
   * 初始化协议连接
   */
  public async initialize(config: ProtocolConfig): Promise<ProtocolResult> {
    this.config = config;
    const token = config.token || '';
    const host = config.host || 'localhost';
    const port = config.port || 8123;

    try {
      return new Promise((resolve, reject) => {
        const wsUrl = `ws://${host}:${port}/api/websocket`;
        this.ws = new WebSocket(wsUrl);

        const timeout = setTimeout(() => {
          reject(new Error('Home Assistant 连接超时'));
        }, config.timeout || 10000);

        this.ws.on('open', () => {
          Logger.info('Home Assistant WebSocket 连接已建立', 'HomeAssistant');
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const message = JSON.parse(data.toString());
            this.handleMessage(message, token, resolve, reject, timeout);
          } catch (error) {
            Logger.error(
              'Home Assistant 消息解析失败',
              error as Error,
              'HomeAssistant'
            );
          }
        });

        this.ws.on('error', (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        });

        this.ws.on('close', () => {
          this.authenticated = false;
          Logger.info('Home Assistant WebSocket 连接已关闭', 'HomeAssistant');
        });
      });
    } catch (error) {
      return {
        success: false,
        error: `Home Assistant 初始化失败: ${(error as Error).message}`,
      };
    }
  }

  /**
   * 发现设备
   */
  public async discover(): Promise<ProtocolResult<DiscoveredDevice[]>> {
    if (!this.authenticated || !this.ws) {
      return { success: false, error: '未连接到 Home Assistant' };
    }

    try {
      const states = (await this.sendMessage({ type: 'get_states' })) as Array<{
        entity_id: string;
        attributes: Record<string, unknown>;
        state: string;
      }>;

      const devices: DiscoveredDevice[] = states.map((state) => {
        const domain = state.entity_id.split('.')[0];
        const name =
          (state.attributes.friendly_name as string) || state.entity_id;

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
    } catch (error) {
      return {
        success: false,
        error: `设备发现失败: ${(error as Error).message}`,
      };
    }
  }

  /**
   * 获取设备状态
   */
  public async getState(
    deviceId: string
  ): Promise<ProtocolResult<DeviceState>> {
    if (!this.authenticated || !this.ws) {
      return { success: false, error: '未连接到 Home Assistant' };
    }

    try {
      const state = (await this.sendMessage({
        type: 'get_states',
      })) as Array<{
        entity_id: string;
        state: string;
        attributes: Record<string, unknown>;
      }>;

      const deviceState = state.find((s) => s.entity_id === deviceId);
      if (!deviceState) {
        return { success: false, error: `设备 ${deviceId} 不存在` };
      }

      return {
        success: true,
        data: this.parseState(deviceState.state, deviceState.attributes),
      };
    } catch (error) {
      return {
        success: false,
        error: `获取状态失败: ${(error as Error).message}`,
      };
    }
  }

  /**
   * 发送命令到设备
   */
  public async sendCommand(
    deviceId: string,
    command: string,
    params?: Record<string, unknown>
  ): Promise<ProtocolResult> {
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
    } catch (error) {
      return {
        success: false,
        error: `命令执行失败: ${(error as Error).message}`,
      };
    }
  }

  /**
   * 订阅设备状态变化
   */
  public async subscribe(
    deviceId: string,
    callback: (state: DeviceState) => void
  ): Promise<ProtocolResult> {
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
    } catch (error) {
      this.subscriptions.delete(deviceId);
      return {
        success: false,
        error: `订阅失败: ${(error as Error).message}`,
      };
    }
  }

  /**
   * 取消订阅
   */
  public async unsubscribe(deviceId: string): Promise<ProtocolResult> {
    this.subscriptions.delete(deviceId);
    return { success: true };
  }

  /**
   * 关闭协议连接
   */
  public async shutdown(): Promise<ProtocolResult> {
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
  private handleMessage(
    message: Record<string, unknown>,
    token: string,
    resolve: (value: ProtocolResult) => void,
    reject: (reason: Error) => void,
    timeout: NodeJS.Timeout
  ): void {
    const msgType = message.type as string;

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
        const id = message.id as number;
        const pending = this.pendingMessages.get(id);
        if (pending) {
          this.pendingMessages.delete(id);
          if (message.success) {
            pending.resolve(message.result as unknown);
          } else {
            pending.reject(
              new Error(
                (message.error as Record<string, string>)?.message || '未知错误'
              )
            );
          }
        }
        break;
      }

      case 'event': {
        const event = (message.event as Record<string, unknown>)
          ?.data as Record<string, unknown>;
        if (event) {
          const entityId = event.entity_id as string;
          const newState = event.new_state as Record<string, unknown>;
          if (entityId && newState) {
            const callback = this.subscriptions.get(entityId);
            if (callback) {
              callback(
                this.parseState(
                  newState.state as string,
                  newState.attributes as Record<string, unknown>
                )
              );
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
  private sendMessage(message: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
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
  private mapDomainToType(domain: string): string {
    const map: Record<string, string> = {
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
  private inferCapabilities(
    domain: string,
    attributes: Record<string, unknown>
  ): string[] {
    const caps: string[] = [];

    switch (domain) {
      case 'light':
        caps.push('power');
        if (attributes.brightness !== undefined) caps.push('brightness');
        if (attributes.rgb_color !== undefined) caps.push('color');
        if (attributes.color_temp !== undefined) caps.push('colorTemperature');
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
  private mapCommandToService(command: string): string {
    const map: Record<string, string> = {
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
  private parseState(
    state: string,
    attributes: Record<string, unknown>
  ): DeviceState {
    const result: DeviceState = {
      online: state !== 'unavailable' && state !== 'unknown',
    };

    if (state === 'on' || state === 'off') {
      result.power = state === 'on';
    }

    if (attributes.brightness !== undefined) {
      result.brightness = Math.round(
        ((attributes.brightness as number) / 255) * 100
      );
    }

    if (attributes.temperature !== undefined) {
      result.temperature = attributes.temperature as number;
    }

    return result;
  }
}
