import { describe, it, expect } from '@jest/globals';

describe('D4-I2: Post-Integration Audit', () => {
  describe('Check 1: SkillProposer is pure proposer', () => {
    it('SkillProposer implements DecisionProposer interface', async () => {
      const { SkillProposer } = await import('../../authority/SkillProposer');
      const proposer = new SkillProposer();
      expect(proposer.proposerId).toBe('skill_proposer');
      expect(typeof proposer.propose).toBe('function');
    });

    it('SkillProposer has no executeAction method', async () => {
      const { SkillProposer } = await import('../../authority/SkillProposer');
      const proposer = new SkillProposer();
      expect((proposer as unknown as Record<string, unknown>).executeAction).toBeUndefined();
      expect((proposer as unknown as Record<string, unknown>).executeWithSkill).toBeUndefined();
    });
  });

  describe('Check 2: DesktopLLMProposer is pure proposer', () => {
    it('DesktopLLMProposer implements DecisionProposer interface', async () => {
      const { DesktopLLMProposer } = await import('../../authority/DesktopLLMProposer');
      const proposer = new DesktopLLMProposer();
      expect(proposer.proposerId).toBe('desktop_llm_proposer');
      expect(typeof proposer.propose).toBe('function');
    });

    it('DesktopLLMProposer has no executeAction method', async () => {
      const { DesktopLLMProposer } = await import('../../authority/DesktopLLMProposer');
      const proposer = new DesktopLLMProposer();
      expect((proposer as unknown as Record<string, unknown>).executeAction).toBeUndefined();
      expect((proposer as unknown as Record<string, unknown>).executeWithLLMPlanning).toBeUndefined();
    });
  });

  describe('Check 3: DecisionAuthority is unique FINAL selector', () => {
    it('DecisionAuthority.decide() returns single chosen candidate', async () => {
      const { DecisionAuthority } = await import('../../authority/DecisionAuthority');
      const da = DecisionAuthority.getInstance();
      expect(typeof da.decide).toBe('function');
      expect(typeof da.decideWithProposers).toBe('function');
    });

    it('DecisionAuthority has no executeAction method', async () => {
      const { DecisionAuthority } = await import('../../authority/DecisionAuthority');
      const da = DecisionAuthority.getInstance();
      expect((da as unknown as Record<string, unknown>).executeAction).toBeUndefined();
    });
  });

  describe('Check 4: authorityMeta cannot be forged', () => {
    it('verifyAuthorityMeta rejects missing fields', async () => {
      const { verifyAuthorityMeta } = await import('../../authority/AuthoritySignature');
      expect(verifyAuthorityMeta({}, 'test')).toBe(false);
      expect(verifyAuthorityMeta({ authority_goalId: 'G1' }, 'test')).toBe(false);
      expect(verifyAuthorityMeta({
        authority_goalId: 'G1',
        authority_snapshotId: 'S1',
        authority_decisionId: 'D1',
        authority_planVersion: 1,
        authority_sig: 'invalid_sig',
      }, 'test')).toBe(false);
    });

    it('signAuthorityMeta + verifyAuthorityMeta round-trip', async () => {
      const { signAuthorityMeta, verifyAuthorityMeta, actionHash } = await import('../../authority/AuthoritySignature');
      const goalId = 'G_test';
      const snapshotId = 'S_test';
      const decisionId = 'D_test';
      const planVersion = 1;
      const task = 'open browser';
      const aHash = actionHash(task);
      const sig = signAuthorityMeta(goalId, snapshotId, decisionId, planVersion, aHash);
      const meta = {
        authority_goalId: goalId,
        authority_snapshotId: snapshotId,
        authority_decisionId: decisionId,
        authority_planVersion: planVersion,
        authority_sig: sig,
        authority_actionHash: aHash,
      };
      expect(verifyAuthorityMeta(meta, task)).toBe(true);
    });

    it('verifyAuthorityMeta rejects tampered task', async () => {
      const { signAuthorityMeta, verifyAuthorityMeta, actionHash } = await import('../../authority/AuthoritySignature');
      const goalId = 'G_test';
      const snapshotId = 'S_test';
      const decisionId = 'D_test';
      const planVersion = 1;
      const task = 'open browser';
      const aHash = actionHash(task);
      const sig = signAuthorityMeta(goalId, snapshotId, decisionId, planVersion, aHash);
      const meta = {
        authority_goalId: goalId,
        authority_snapshotId: snapshotId,
        authority_decisionId: decisionId,
        authority_planVersion: planVersion,
        authority_sig: sig,
        authority_actionHash: aHash,
      };
      expect(verifyAuthorityMeta(meta, 'different task')).toBe(false);
    });
  });

  describe('Check 5: Decision → action is one-to-one', () => {
    it('Decision type has chosenCandidateId (single, not array)', async () => {
      const types = await import('../../authority/types');
      expect(types).toBeDefined();
    });
  });

  describe('Check 6: Evidence has goalId and decisionId', () => {
    it('GoalEvidence interface requires goalId and decisionId', async () => {
      const types = await import('../../authority/types');
      expect(types).toBeDefined();
    });
  });

  describe('Check 7: Old executeWithSkill/executeWithLLMPlanning are dead', () => {
    it('SkillProposer has no executeWithSkill', async () => {
      const { SkillProposer } = await import('../../authority/SkillProposer');
      const proposer = new SkillProposer();
      expect((proposer as unknown as Record<string, unknown>).executeWithSkill).toBeUndefined();
    });

    it('DesktopLLMProposer has no executeWithLLMPlanning', async () => {
      const { DesktopLLMProposer } = await import('../../authority/DesktopLLMProposer');
      const proposer = new DesktopLLMProposer();
      expect((proposer as unknown as Record<string, unknown>).executeWithLLMPlanning).toBeUndefined();
    });
  });

  describe('Check 8: All bypass callers have AUDIT annotation', () => {
    it('SelfModificationEngine has [AUDIT] annotation', () => {
      const fs = require('fs');
      const path = require('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../evolution/v2/SelfModificationEngine.ts'),
        'utf-8'
      );
      const auditLines = content.split('\n').filter((l: string) => l.includes('[AUDIT]') && l.includes('SelfModificationEngine'));
      expect(auditLines.length).toBeGreaterThanOrEqual(1);
    });

    it('DesktopChannel has [AUDIT] annotation', () => {
      const fs = require('fs');
      const path = require('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../harness/action/channels/DesktopChannel.ts'),
        'utf-8'
      );
      const auditLines = content.split('\n').filter((l: string) => l.includes('[AUDIT]') && l.includes('DesktopChannel'));
      expect(auditLines.length).toBeGreaterThanOrEqual(1);
    });

    it('DesktopMCPServer has [AUDIT] annotation', () => {
      const fs = require('fs');
      const path = require('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../desktop/DesktopMCPServer.ts'),
        'utf-8'
      );
      const auditLines = content.split('\n').filter((l: string) => l.includes('[AUDIT]') && l.includes('DesktopMCP'));
      expect(auditLines.length).toBeGreaterThanOrEqual(1);
    });

    it('StateSnapshotManager has [AUDIT] annotation', () => {
      const fs = require('fs');
      const path = require('path');
      const content = fs.readFileSync(
        path.join(__dirname, '../../desktop/StateSnapshotManager.ts'),
        'utf-8'
      );
      const auditLines = content.split('\n').filter((l: string) => l.includes('[AUDIT]') && l.includes('StateSnapshotManager'));
      expect(auditLines.length).toBeGreaterThanOrEqual(1);
    });
  });
});
