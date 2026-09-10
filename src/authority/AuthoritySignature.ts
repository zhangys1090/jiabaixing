/**
 * D4-I2 Post-Audit: authorityMeta HMAC 防伪造校验（TS 侧）。
 *
 * 与 Python 端 agent/core/authority_signature.py 算法逐字节一致：
 *   message = `${goalId}|${snapshotId}|${decisionId}|${actionHash}`
 *   sig     = HMAC-SHA256(secret, message).hex
 *   actionHash = SHA-256(task).hex
 *
 * 密钥：环境变量 AGENT_AUTHORITY_HMAC_SECRET，两端必须一致；
 * 未设置时回退内置开发默认值（生产必须显式设置，isProductionSecret() 供告警）。
 */

import * as crypto from 'crypto';

const DEV_FALLBACK_SECRET = 'jiabaixing-dev-authority-secret';

function getSecret(): string {
  return process.env.AGENT_AUTHORITY_HMAC_SECRET || DEV_FALLBACK_SECRET;
}

export function isProductionSecret(): boolean {
  return Boolean(process.env.AGENT_AUTHORITY_HMAC_SECRET);
}

export function actionHash(task: string): string {
  return crypto.createHash('sha256').update(task, 'utf8').digest('hex');
}

export function signAuthorityMeta(
  goalId: string,
  snapshotId: string,
  decisionId: string,
  actionHashHex: string
): string {
  const message = `${goalId}|${snapshotId}|${decisionId}|${actionHashHex}`;
  return crypto
    .createHmac('sha256', getSecret())
    .update(message, 'utf8')
    .digest('hex');
}

/**
 * 校验 delegated authorityMeta 的签名。
 *
 * 返回 true 才允许走 delegated 执行路径；false 时调用方必须
 * fail-safe 降级为 TS 本地 DecisionAuthority 决策链。
 */
export function verifyAuthorityMeta(
  meta: Record<string, unknown>,
  task: string
): boolean {
  const goalId = String(meta['authority_goalId'] ?? '');
  const snapshotId = String(meta['authority_snapshotId'] ?? '');
  const decisionId = String(meta['authority_decisionId'] ?? '');
  const sig = String(meta['authority_sig'] ?? '');
  const claimedHash = String(meta['authority_actionHash'] ?? '');

  if (!goalId || !snapshotId || !decisionId || !sig) {
    return false;
  }

  // actionHash 必须与当前 task 内容一致（防"换货"），缺失时按 task 重算。
  const expectedHash = claimedHash || actionHash(task);
  if (claimedHash && claimedHash !== actionHash(task)) {
    return false;
  }

  const expected = signAuthorityMeta(goalId, snapshotId, decisionId, expectedHash);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}
