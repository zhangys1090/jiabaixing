import { EventBus } from '../../shared/EventBus';
import type { IntegrationPlatform } from '../../shared/contracts';
import type { JiabaixingCore } from '../../core/JiabaixingCore';
import { Logger } from '../../utils/Logger';

export interface GatewayInitResult {}

export async function initGateway(
  core: JiabaixingCore,
  _harness: unknown
): Promise<GatewayInitResult> {
  const { GatewayBridge } = await import('../../integration/GatewayBridge');
  const gatewayBridge = GatewayBridge.getInstance();

  gatewayBridge.setIncomingMessageHandler(async (message) => {
    Logger.info(`收到平台消息: ${message.platform}`, 'Bootstrap');

    try {
      const result = await core.processInput(message.content, message.from);

      if (result.response && message.from && message.platform) {
        await gatewayBridge.sendMessage({
          platform: message.platform,
          message: result.response,
          to: message.from,
        });
      }
    } catch (error) {
      Logger.error(
        `处理平台消息失败: ${(error as Error).message}`,
        error as Error,
        'Bootstrap'
      );
    }
  });

  try {
    await gatewayBridge.start();
    console.log('✅ (隔离进程模式)');
    Logger.info('网关启动成功: 隔离进程模式', 'Bootstrap');
  } catch (err) {
    Logger.warn(
      `网关隔离进程启动失败: ${(err as Error).message}，回退到内联模式`,
      'Bootstrap'
    );
    const { IntegrationManager } =
      await import('../../integration/IntegrationManager');
    const integrationManager = IntegrationManager.getInstance();
    integrationManager.setCore(core);
    console.log('✅ (内联模式)');
    Logger.info('网关启动成功: 内联模式', 'Bootstrap');
  }

  EventBus.on('integration_message', async (data: unknown) => {
    try {
      const payload = data as {
        content: string;
        from?: string;
        platform?: string;
      };
      Logger.info(`收到平台消息: ${payload.platform}`, 'Bootstrap');

      const result = await core.processInput(payload.content, payload.from);

      if (result.response && payload.from && payload.platform) {
        if (gatewayBridge.isWorkerAlive()) {
          await gatewayBridge.sendMessage({
            platform: payload.platform as IntegrationPlatform,
            message: result.response,
            to: payload.from,
          });
        } else {
          const { IntegrationManager } =
            await import('../../integration/IntegrationManager');
          const im = IntegrationManager.getInstance();
          await im.sendMessage({
            platform: payload.platform as IntegrationPlatform,
            message: result.response,
            to: payload.from,
          });
        }
      }
    } catch (error) {
      Logger.error('处理集成消息失败', error as Error, 'Bootstrap');
    }
  });

  return {};
}
