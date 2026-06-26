import type { DataSovereigntyPipeline } from '../../security/DataSovereigntyPipeline';

export interface SecurityInitResult {
  sovereigntyPipeline: DataSovereigntyPipeline;
  securityCore: import('../../security/SecurityCore').SecurityCore;
}

export async function initSecurity(): Promise<SecurityInitResult> {
  const { NetworkGuard } = await import('../../security/NetworkGuard');
  NetworkGuard.install();

  const { DataSovereigntyPipeline } =
    await import('../../security/DataSovereigntyPipeline');
  const sovereigntyPipeline = new DataSovereigntyPipeline();
  sovereigntyPipeline.initialize();

  const { SecurityCore } = await import('../../security/SecurityCore');
  const securityCore = SecurityCore.getInstance({
    enableNetworkGuard: true,
    enableUrlSafety: true,
    enableSslGuard: true,
    enableShellHooks: true,
  });

  const health = securityCore.healthCheck();
  const { Logger } = await import('../../utils/Logger');
  Logger.info(
    `🛡️ 安全核心已初始化: ${JSON.stringify(health.details)}`,
    'initSecurity'
  );

  return { sovereigntyPipeline, securityCore };
}
