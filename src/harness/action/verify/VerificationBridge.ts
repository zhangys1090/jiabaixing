/**
 * VerificationBridge —— 桌面动作接回 action_verifier 的桥接层
 *
 * 校验核心（ActionVerifier）在 Python 端（agent.perception.action_verifier）。
 * 本桥提供两种实现：
 *   - PythonVerificationBridge：经 HTTP 调用 PYTHON_AGENT_URL/v1/perception/verify-action，
 *     复用 Python 侧多策略验证（pixel/ocr/vlm/uia_diff）。
 *   - LocalVerificationBridge：Python 不可达时的本地兜底，保守判定。
 *
 * 通过 getActionVerificationBridge() 获取默认实例（Python 优先）。
 */

import { Logger } from '../../../utils/Logger';
import type { VerifyRequest, VerificationOutcome } from '../types';

export interface VerificationBridge {
  readonly mode: 'python' | 'local';
  verify(req: VerifyRequest): Promise<VerificationOutcome>;
}

export class PythonVerificationBridge implements VerificationBridge {
  readonly mode = 'python' as const;

  constructor(
    private readonly baseUrl: string = process.env.PYTHON_AGENT_URL ||
      'http://localhost:3112'
  ) {}

  async verify(req: VerifyRequest): Promise<VerificationOutcome> {
    const base = this.baseUrl.replace(/\/$/, '');
    const url = `${base}/v1/perception/verify-action`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action_description: req.description,
          pre_path: req.prePath ?? '',
          post_path: req.postPath ?? '',
          strategy: req.strategy ?? 'auto',
          target_region: req.targetRegion ?? '',
          threshold: req.threshold ?? 0.01,
          question: req.question ?? '',
        }),
        signal: ctrl.signal,
      });

      if (!resp.ok) {
        Logger.warn(
          `VerificationBridge(Python) 返回非 2xx: ${resp.status}`,
          'VerificationBridge'
        );
        return {
          success: false,
          confidence: 0,
          evidence: `HTTP ${resp.status}`,
          retrySuggested: false,
          method: 'python_error',
          diffRatio: 0,
        };
      }

      const data = (await resp.json()) as Record<string, unknown>;
      return {
        success: Boolean(data.success),
        confidence: Number(data.confidence ?? 0),
        evidence: String(data.evidence ?? ''),
        retrySuggested: Boolean(data.retry_suggested),
        method: String(data.method ?? 'python'),
        diffRatio: Number(data.diff_ratio ?? 0),
      };
    } catch (err) {
      Logger.warn(
        `VerificationBridge(Python) 调用失败: ${(err as Error).message}`,
        'VerificationBridge'
      );
      return {
        success: false,
        confidence: 0,
        evidence: `bridge error: ${(err as Error).message}`,
        retrySuggested: false,
        method: 'python_error',
        diffRatio: 0,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class LocalVerificationBridge implements VerificationBridge {
  readonly mode = 'local' as const;

  async verify(req: VerifyRequest): Promise<VerificationOutcome> {
    // 本地兜底：无法调用 Python ActionVerifier 时的保守判定。
    // 提供了前后截图 → 标记为待 Python 复核；否则无法客观验证。
    if (req.prePath && req.postPath) {
      return {
        success: true,
        confidence: 0.5,
        evidence: '本地兜底：已提供前后截图，建议经 Python ActionVerifier 复核',
        retrySuggested: false,
        method: 'local',
        diffRatio: 0,
      };
    }
    return {
      success: true,
      confidence: 0.3,
      evidence: '本地兜底：未提供截图，无法客观验证',
      retrySuggested: false,
      method: 'local',
      diffRatio: 0,
    };
  }
}

let _bridge: VerificationBridge | null = null;

export function getActionVerificationBridge(): VerificationBridge {
  if (!_bridge) _bridge = new PythonVerificationBridge();
  return _bridge;
}

export function setActionVerificationBridge(bridge: VerificationBridge): void {
  _bridge = bridge;
}
