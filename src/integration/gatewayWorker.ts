import { IntegrationManager } from './IntegrationManager';
import { Logger } from '../utils/Logger';
import { EventBus } from '../shared/EventBus';
import type { IntegrationPlatform, PlatformConfig } from '../shared/contracts';

interface IpcMessage {
  id: string;
  type: string;
  payload?: unknown;
}

interface IpcResponse {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

const im = IntegrationManager.getInstance();

function send(msg: IpcResponse): void {
  if (process.send) {
    process.send(msg);
  }
}

function handleMessage(msg: IpcMessage): void {
  switch (msg.type) {
    case 'connect': {
      const { platform, config } = msg.payload as {
        platform: IntegrationPlatform;
        config: PlatformConfig;
      };
      im.connectPlatform(platform, config)
        .then((success) => {
          send({
            id: msg.id,
            success,
            data: { platform, status: success ? 'connected' : 'failed' },
          });
        })
        .catch((err: Error) => {
          send({ id: msg.id, success: false, error: err.message });
        });
      break;
    }
    case 'disconnect': {
      const { platform: dp } = msg.payload as { platform: IntegrationPlatform };
      im.disconnectPlatform(dp)
        .then(() => {
          send({ id: msg.id, success: true, data: { platform: dp } });
        })
        .catch((err: Error) => {
          send({ id: msg.id, success: false, error: err.message });
        });
      break;
    }
    case 'sendMessage': {
      const req = msg.payload as {
        platform: IntegrationPlatform;
        message: string;
        to?: string;
        imageUrls?: string[];
        mentions?: string[];
      };
      im.sendMessage(req)
        .then((result) => {
          send({ id: msg.id, success: result.success, data: result });
        })
        .catch((err: Error) => {
          send({ id: msg.id, success: false, error: err.message });
        });
      break;
    }
    case 'getPlatforms': {
      const platforms = im.getPlatforms();
      send({ id: msg.id, success: true, data: { platforms } });
      break;
    }
    case 'getStatus': {
      const { platform: sp } = msg.payload as { platform: IntegrationPlatform };
      const status = im.getPlatformStatus(sp);
      send({ id: msg.id, success: true, data: status });
      break;
    }
    case 'getWeChatQRState': {
      const qrState = im.getWeChatQRState();
      send({ id: msg.id, success: true, data: qrState });
      break;
    }
    case 'handleWebhook': {
      const { platform: wp, payload: wPayload } = msg.payload as {
        platform: IntegrationPlatform;
        payload: Record<string, unknown>;
      };
      im.handleWebhook(wp, wPayload)
        .then((result) => {
          send({ id: msg.id, success: result.success, data: result });
        })
        .catch((err: Error) => {
          send({ id: msg.id, success: false, error: err.message });
        });
      break;
    }
    case 'ping': {
      send({
        id: msg.id,
        success: true,
        data: { status: 'alive', pid: process.pid },
      });
      break;
    }
    default:
      send({
        id: msg.id,
        success: false,
        error: `Unknown message type: ${msg.type}`,
      });
  }
}

EventBus.on(
  'integration_message',
  (message: {
    platform: string;
    type: string;
    content: string;
    from?: string;
    fromName?: string;
    timestamp: string;
    rawData?: unknown;
  }) => {
    send({
      id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      success: true,
      data: { type: 'incoming_message', payload: message },
    });
  }
);

process.on('message', (msg: IpcMessage) => {
  handleMessage(msg);
});

process.on('uncaughtException', (error: Error) => {
  Logger.error('Gateway Worker 未捕获异常', error, 'GatewayWorker');
  try {
    send({
      id: `err_${Date.now()}`,
      success: false,
      error: `Worker uncaught exception: ${error.message}`,
    });
  } catch {
    // 发送失败也继续退出
  }
  // 未捕获异常代表 Worker 已处于损坏状态，必须退出由父进程重启，
  // 否则僵尸 Worker 持续运行（审计 S-02：原仅上报不退出）。
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  Logger.error(
    'Gateway Worker 未处理的 Promise 拒绝',
    reason as Error,
    'GatewayWorker'
  );
  try {
    send({
      id: `err_${Date.now()}`,
      success: false,
      error: `Worker unhandled rejection: ${String(reason)}`,
    });
  } catch {
    // 发送失败也继续退出
  }
  process.exit(1);
});

Logger.info('🟢 Gateway Worker 已启动', 'GatewayWorker');
send({
  id: 'worker_ready',
  success: true,
  data: { type: 'ready', pid: process.pid },
});
