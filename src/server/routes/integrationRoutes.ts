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
import { IntegrationManager } from '../../integration/IntegrationManager';
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
    const gateway = getGateway();
    const platforms = isBridge(gateway)
      ? gateway.getPlatforms()
      : gateway.getPlatforms();

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
    const gateway = getGateway();
    const status = isBridge(gateway)
      ? gateway.getPlatformStatus(platform)
      : gateway.getPlatformStatus(platform);

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

    const gateway = getGateway();
    const success = isBridge(gateway)
      ? await gateway.connectPlatform(platform, requestBody.config)
      : await gateway.connectPlatform(platform, requestBody.config);

    const response: ApiResponse<PlatformConnectResponse> = {
      success,
      data: {
        success,
        platform,
        status: success ? 'connected' : 'failed',
      },
    };

    if (!success) {
      response.error = '连接失败';
    }

    res.status(success ? 200 : 400).json(response);
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
    const gateway = getGateway();

    const result = isBridge(gateway)
      ? await gateway.handleWebhook(platform, req.body)
      : await gateway.handleWebhook(platform, req.body);

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

export default router;
