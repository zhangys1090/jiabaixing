import express, { Request, Response } from 'express';
import { Logger } from '../../utils/Logger';
import {
  IntegrationPlatform,
  ConnectRequest,
  SendMessageRequest,
  ApiResponse,
  IntegrationStatusResponse,
  PlatformConnectResponse,
  PlatformDisconnectResponse,
  SendMessageResponse,
} from '../../shared/contracts';
import {
  IntegrationManager,
  WebhookEndpoint,
} from '../../integration/IntegrationManager';
import { GatewayBridge } from '../../integration/GatewayBridge';

const router = express.Router();

function getGateway(): IntegrationManager | GatewayBridge {
  const bridge = GatewayBridge.getInstance();
  if (bridge.isWorkerAlive()) {
    return bridge;
  }
  return IntegrationManager.getInstance();
}

function isBridge(
  gateway: IntegrationManager | GatewayBridge
): gateway is GatewayBridge {
  return gateway instanceof GatewayBridge;
}

router.get('/wechat/qrcode', async (_req: Request, res: Response) => {
  try {
    const gateway = getGateway();
    const qrState = isBridge(gateway)
      ? gateway.getWeChatQRState()
      : gateway.getWeChatQRState();

    if (!qrState) {
      res.json({
        success: false,
        error: '未开启微信扫码模式，请先连接 (mode: qr)',
      });
      return;
    }
    res.json({
      success: true,
      data: qrState,
    });
  } catch (error) {
    Logger.error('获取微信二维码失败', error as Error, 'IntegrationRoutes');
    res.status(500).json({
      success: false,
      error: '获取微信二维码失败',
    });
  }
});

router.get('/platforms', async (_req: Request, res: Response) => {
  try {
    // 状态查询直接走 IntegrationManager，不走 GatewayBridge（sendSyncRequest 会阻塞事件循环）
    const im = IntegrationManager.getInstance();
    const platforms = im.getPlatforms();

    const response: ApiResponse<IntegrationStatusResponse> = {
      success: true,
      data: { platforms },
    };
    res.json(response);
  } catch (error) {
    Logger.error('获取集成平台失败', error as Error, 'IntegrationRoutes');
    res.status(500).json({
      success: false,
      error: '获取集成平台信息失败',
      message: (error as Error).message,
    });
  }
});

router.get('/:platform/status', async (req: Request, res: Response) => {
  try {
    const platform = req.params.platform as IntegrationPlatform;
    // 状态查询直接走 IntegrationManager
    const im = IntegrationManager.getInstance();
    const status = im.getPlatformStatus(platform);

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    Logger.error('获取平台状态失败', error as Error, 'IntegrationRoutes');
    res.status(500).json({
      success: false,
      error: '获取平台状态失败',
    });
  }
});

router.post('/:platform/connect', async (req: Request, res: Response) => {
  try {
    const platform = req.params.platform as IntegrationPlatform;
    const requestBody = req.body as ConnectRequest;

    // 连接操作走 GatewayBridge (async sendRequest 正常工作)
    const gateway = getGateway();
    const result = isBridge(gateway)
      ? await gateway.connectPlatform(platform, requestBody.config)
      : await gateway.connectPlatform(platform, requestBody.config);

    // result 在 GatewayBridge 模式下是 IPC data 对象，在 IntegrationManager 模式下是 boolean
    const connected =
      result === true ||
      (typeof result === 'object' &&
        result !== null &&
        (result as any).status === 'connected');

    const response: ApiResponse<PlatformConnectResponse> = {
      success: connected,
      data: {
        success: connected,
        platform,
        status: connected ? 'connected' : 'failed',
      },
    };

    if (!connected) {
      response.error = '连接失败';
    }

    res.status(connected ? 200 : 400).json(response);
  } catch (error) {
    Logger.error('连接平台失败', error as Error, 'IntegrationRoutes');
    res.status(500).json({
      success: false,
      error: '连接平台失败',
      message: (error as Error).message,
    });
  }
});

router.post('/:platform/disconnect', async (req: Request, res: Response) => {
  try {
    const platform = req.params.platform as IntegrationPlatform;
    const gateway = getGateway();

    if (isBridge(gateway)) {
      await gateway.disconnectPlatform(platform);
    } else {
      await gateway.disconnectPlatform(platform);
    }

    const response: ApiResponse<PlatformDisconnectResponse> = {
      success: true,
      data: {
        success: true,
        platform,
      },
    };

    res.json(response);
  } catch (error) {
    Logger.error('断开连接失败', error as Error, 'IntegrationRoutes');
    res.status(500).json({
      success: false,
      error: '断开连接失败',
    });
  }
});

router.post('/:platform/webhook', async (req: Request, res: Response) => {
  try {
    const platform = req.params.platform as IntegrationPlatform;
    // webhook 直接走主进程 IntegrationManager（有 core 才能处理消息并回复）
    const im = IntegrationManager.getInstance();
    const result = await im.handleWebhook(platform, req.body);

    if (result.success) {
      res.status(200).json(result.response || { success: true });
    } else {
      res.status(400).json({ success: false });
    }
  } catch (error) {
    Logger.error('处理 Webhook 失败', error as Error, 'IntegrationRoutes');
    res.status(500).json({ success: false });
  }
});

router.post('/:platform/send', async (req: Request, res: Response) => {
  try {
    const platform = req.params.platform as IntegrationPlatform;
    const requestBody: SendMessageRequest = {
      ...req.body,
      platform,
    };

    const gateway = getGateway();
    const response = isBridge(gateway)
      ? await gateway.sendMessage(requestBody)
      : await gateway.sendMessage(requestBody);

    const apiResponse: ApiResponse<SendMessageResponse> = {
      success: response.success,
      data: response,
    };

    if (!response.success) {
      apiResponse.error = response.error;
    }

    res.status(response.success ? 200 : 400).json(apiResponse);
  } catch (error) {
    Logger.error('发送消息失败', error as Error, 'IntegrationRoutes');
    res.status(500).json({
      success: false,
      error: '发送消息失败',
      message: (error as Error).message,
    });
  }
});

router.get('/system-status', async (_req: Request, res: Response) => {
  try {
    const bridge = GatewayBridge.getInstance();
    const systemStatus = {
      timestamp: Date.now(),
      architecture: 'v5.0-harness-isolated-gateway',
      gateway: {
        mode: bridge.isWorkerAlive() ? 'isolated_worker' : 'inline_fallback',
        workerAlive: bridge.isWorkerAlive(),
      },
      layers: {
        preprocessor: 'active',
        llmCore: 'active',
        postprocessor: 'active',
      },
      overall: {
        status: 'operational',
      },
    };

    res.json({
      success: true,
      data: systemStatus,
    });
  } catch (error) {
    Logger.error('获取系统状态失败', error as Error, 'IntegrationRoutes');
    res.status(500).json({
      success: false,
      error: '获取系统状态失败',
      details: (error as Error).message,
    });
  }
});

// ====================== Webhook 管理 API ======================

/**
 * 注册 Webhook 端点
 */
router.post('/webhooks', async (req: Request, res: Response) => {
  try {
    const endpoint = req.body as WebhookEndpoint;

    if (
      !endpoint.id ||
      !endpoint.name ||
      !endpoint.url ||
      !Array.isArray(endpoint.events)
    ) {
      res.status(400).json({
        success: false,
        error: '缺少必填字段: id, name, url, events',
      });
      return;
    }

    const manager = IntegrationManager.getInstance();
    manager.registerWebhook({
      ...endpoint,
      enabled: endpoint.enabled ?? true,
      retryCount: endpoint.retryCount ?? 3,
      timeout: endpoint.timeout ?? 5000,
    });

    Logger.info(
      `Webhook 已注册: ${endpoint.id} (${endpoint.name})`,
      'IntegrationRoutes'
    );

    res.status(201).json({
      success: true,
      data: { id: endpoint.id },
    });
  } catch (error) {
    Logger.error('注册 Webhook 失败', error as Error, 'IntegrationRoutes');
    res.status(500).json({
      success: false,
      error: '注册 Webhook 失败',
      message: (error as Error).message,
    });
  }
});

/**
 * 注销 Webhook 端点
 */
router.delete('/webhooks/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const manager = IntegrationManager.getInstance();
    manager.unregisterWebhook(id);

    Logger.info(`Webhook 已注销: ${id}`, 'IntegrationRoutes');

    res.json({
      success: true,
      data: { id },
    });
  } catch (error) {
    Logger.error('注销 Webhook 失败', error as Error, 'IntegrationRoutes');
    res.status(500).json({
      success: false,
      error: '注销 Webhook 失败',
      message: (error as Error).message,
    });
  }
});

/**
 * 列出所有 Webhook 端点
 */
router.get('/webhooks', async (_req: Request, res: Response) => {
  try {
    const manager = IntegrationManager.getInstance();
    const webhooks = manager.listWebhooks();

    res.json({
      success: true,
      data: { webhooks },
    });
  } catch (error) {
    Logger.error('获取 Webhook 列表失败', error as Error, 'IntegrationRoutes');
    res.status(500).json({
      success: false,
      error: '获取 Webhook 列表失败',
      message: (error as Error).message,
    });
  }
});

/**
 * 测试 Webhook 连通性
 */
router.post('/webhooks/:id/test', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const manager = IntegrationManager.getInstance();
    const endpoint = manager.getWebhook(id);

    if (!endpoint) {
      res.status(404).json({
        success: false,
        error: `Webhook 端点不存在: ${id}`,
      });
      return;
    }

    const testPayload = {
      message: 'jiabaixing Webhook 连通性测试',
      timestamp: new Date().toISOString(),
    };

    const success = await manager.deliverWebhook(
      endpoint,
      'webhook_test',
      testPayload
    );

    res.json({
      success,
      data: {
        id,
        delivered: success,
        message: success ? 'Webhook 连通性测试成功' : 'Webhook 连通性测试失败',
      },
    });
  } catch (error) {
    Logger.error('测试 Webhook 失败', error as Error, 'IntegrationRoutes');
    res.status(500).json({
      success: false,
      error: '测试 Webhook 失败',
      message: (error as Error).message,
    });
  }
});

export default router;
