/**
 * D4-I2 Post-Audit: AuthoritySignature 单元测试。
 *
 * 与 Python 端 agent/core/authority_signature.py 互操作由
 * 跨语言运行时验证覆盖（见 docs/D4_I2_Post_Integration_Audit_2026-09-10.md）；
 * 此处锁定 TS 侧签名/校验的独立行为。
 */

import { verifyAuthorityMeta, signAuthorityMeta, actionHash, isProductionSecret } from '../../../src/authority/AuthoritySignature';

const GOAL = 'G_test123';
const SNAP = 'SS_test456';
const DEC = 'D_test789';
const TASK = '打开记事本并输入Hello World';

function makeMeta(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const ahash = actionHash(TASK);
  return {
    authority_goalId: GOAL,
    authority_snapshotId: SNAP,
    authority_decisionId: DEC,
    authority_actionHash: ahash,
    authority_sig: signAuthorityMeta(GOAL, SNAP, DEC, ahash),
    ...overrides,
  };
}

describe('AuthoritySignature', () => {
  it('verifies a correctly signed delegated meta', () => {
    expect(verifyAuthorityMeta(makeMeta(), TASK)).toBe(true);
  });

  it('rejects when task content is swapped (同一 decisionId 换货)', () => {
    expect(verifyAuthorityMeta(makeMeta(), `${TASK} && rm -rf /`)).toBe(false);
  });

  it('rejects tampered decisionId', () => {
    expect(verifyAuthorityMeta(makeMeta({ authority_decisionId: 'D_fake' }), TASK)).toBe(false);
  });

  it('rejects tampered actionHash', () => {
    expect(verifyAuthorityMeta(makeMeta({ authority_actionHash: '0'.repeat(64) }), TASK)).toBe(false);
  });

  it('rejects legacy bare metadata without signature', () => {
    const bare = {
      authority_goalId: GOAL,
      authority_snapshotId: SNAP,
      authority_decisionId: DEC,
    };
    expect(verifyAuthorityMeta(bare, TASK)).toBe(false);
  });

  it('rejects missing fields', () => {
    expect(verifyAuthorityMeta({}, TASK)).toBe(false);
    expect(verifyAuthorityMeta({ authority_sig: 'x' }, TASK)).toBe(false);
  });

  it('actionHash is deterministic and content-bound', () => {
    expect(actionHash(TASK)).toBe(actionHash(TASK));
    expect(actionHash(TASK)).not.toBe(actionHash(`${TASK}x`));
  });

  it('isProductionSecret reflects env configuration', () => {
    const old = process.env.AGENT_AUTHORITY_HMAC_SECRET;
    try {
      delete process.env.AGENT_AUTHORITY_HMAC_SECRET;
      expect(isProductionSecret()).toBe(false);
      process.env.AGENT_AUTHORITY_HMAC_SECRET = 's3cret';
      expect(isProductionSecret()).toBe(true);
    } finally {
      if (old !== undefined) {
        process.env.AGENT_AUTHORITY_HMAC_SECRET = old;
      } else {
        delete process.env.AGENT_AUTHORITY_HMAC_SECRET;
      }
    }
  });
});
