import type { DataSovereigntyPipeline } from '../../security/DataSovereigntyPipeline';

export interface SecurityInitResult {
  sovereigntyPipeline: DataSovereigntyPipeline;
}

export async function initSecurity(): Promise<SecurityInitResult> {
  const { NetworkGuard } = await import('../../security/NetworkGuard');
  NetworkGuard.install();
  const { DataSovereigntyPipeline } =
    await import('../../security/DataSovereigntyPipeline');
  const sovereigntyPipeline = new DataSovereigntyPipeline();
  sovereigntyPipeline.initialize();
  return { sovereigntyPipeline };
}
